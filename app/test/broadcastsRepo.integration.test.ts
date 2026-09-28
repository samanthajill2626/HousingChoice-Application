// Integration tests against DynamoDB Local — the REAL UpdateExpression
// semantics for the nested-map repo writes that the in-memory fakes cannot
// validate. DynamoDB Local statically rejects an UpdateExpression that SETs
// BOTH a map and a child of that map ("Two document paths overlap"), and
// rejects unused ExpressionAttributeValues — neither of which the fakes model.
// These suites would have caught the broadcasts.setRecipient /
// messages.setRecipientDelivery overlap bug (enqueue_failed on a real send).
//
// It also covers the FAN-OUT PASS CLAIM (M5) on both repos: `claimFanoutPass`
// is a conditional ADD on a TOP-LEVEL scalar (`fanout_attempt`) whose atomicity,
// cap refusal and missing-vs-capped disambiguation only exist against a real
// DynamoDB. The fakes model the semantics; they cannot model the race, and a
// slot-resident counter would look correct in them.
//
// Self-skipping like the other integration suites: when nothing answers at
// DYNAMODB_ENDPOINT (default http://localhost:8000) the suite is skipped so
// `npm test` stays green without Docker (`npm run db:start` to run for real).
import { randomUUID } from 'node:crypto';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
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

describe.skipIf(!reachable)('broadcast + relay repo UpdateExpressions and fan-out pass claims against DynamoDB Local', () => {
  const testEnv = { TABLE_PREFIX: `hc-test-${randomUUID().slice(0, 8)}-` };
  const client = createDynamoClient({ endpoint });
  const doc = createDocumentClient({ endpoint });
  const logger = createLogger({ destination: createLogCapture().stream });
  const repoDeps = { doc, env: testEnv, logger };

  const broadcasts = createBroadcastsRepo(repoDeps);
  const messages = createMessagesRepo(repoDeps);

  const bases = ['broadcasts', 'messages'] as const;
  const broadcastsTable = tableName('broadcasts', testEnv);
  const messagesTable = tableName('messages', testEnv);

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

  it('share-skip-fix D7: bumpStats ADDs skipped_other onto a persisted stats map that predates the field (a share mid-send at deploy)', async () => {
    const created = await broadcasts.create({
      created_by: 'usr_test',
      audience_filter: { contact_type: 'tenant', excludeOptedOut: true, excludeUnreachable: true },
      body_template: 'Hi [TenantName]',
    });
    await broadcasts.markSending(created.broadcastId, { 'c-1': { status: 'queued' } });
    // Simulate the pre-deploy shape: the field is absent from the stored map.
    await doc.send(
      new UpdateCommand({
        TableName: broadcastsTable,
        Key: { broadcastId: created.broadcastId },
        UpdateExpression: 'REMOVE stats.skipped_other',
      }),
    );
    // Precondition: the stored map really lacks the key, so the ADD below
    // exercises the absent-nested-counter path (not an ADD onto a seeded 0).
    const { Item: stored } = await doc.send(
      new GetCommand({ TableName: broadcastsTable, Key: { broadcastId: created.broadcastId }, ConsistentRead: true }),
    );
    expect((stored as { stats: Record<string, unknown> }).stats).not.toHaveProperty('skipped_other');
    expect((stored as { stats: Record<string, unknown> }).stats).toHaveProperty('queued', 1);
    const bumped = await broadcasts.bumpStats(created.broadcastId, { skipped_other: 1, queued: -1 });
    expect(bumped.stats.skipped_other).toBe(1);
    expect(bumped.stats.queued).toBe(0);
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

  // --- Broadcasts dashboard Phase A: byUnit GSI + conditional delete --------
  // These exercise the REAL DynamoDB-Local semantics the in-memory fake cannot:
  // the sparse byUnit GSI projection/query and the status='draft'-conditional
  // DeleteCommand (incl. the draft→sending race that must fail the condition).

  it('byUnit GSI: listByUnit returns this unit\'s broadcasts; a unit-less broadcast never indexes', async () => {
    const unitId = `unit-${randomUUID().slice(0, 8)}`;
    const a = await broadcasts.create({
      created_by: 'usr_test',
      audience_filter: { contact_type: 'tenant', excludeOptedOut: true, excludeUnreachable: true },
      body_template: 'a',
      unitId,
    });
    const b = await broadcasts.create({
      created_by: 'usr_test',
      audience_filter: { contact_type: 'tenant', excludeOptedOut: true, excludeUnreachable: true },
      body_template: 'b',
      unitId,
    });
    // A unit-LESS broadcast: sparse GSI means it never appears for any unit.
    await broadcasts.create({
      created_by: 'usr_test',
      audience_filter: { contact_type: 'tenant', excludeOptedOut: true, excludeUnreachable: true },
      body_template: 'no-unit',
    });

    const page = await broadcasts.listByUnit(unitId);
    expect(page.items.map((x) => x.broadcastId).sort()).toEqual([a.broadcastId, b.broadcastId].sort());
  });

  it('conditional delete: a DRAFT deletes; a SENT broadcast is refused (not_draft) and survives', async () => {
    const draft = await broadcasts.create({
      created_by: 'usr_test',
      audience_filter: { contact_type: 'tenant', excludeOptedOut: true, excludeUnreachable: true },
      body_template: 'deletable',
    });
    const okDelete = await broadcasts.delete(draft.broadcastId);
    expect(okDelete).toEqual({ deleted: true });
    expect(await broadcasts.getById(draft.broadcastId)).toBeUndefined();

    // A missing broadcast → not_found.
    const missing = await broadcasts.delete(`bcast-${randomUUID()}`);
    expect(missing).toEqual({ deleted: false, reason: 'not_found' });

    // A SENT broadcast → not_draft (the conditional refuses), the row survives.
    const sent = await broadcasts.create({
      created_by: 'usr_test',
      audience_filter: { contact_type: 'tenant', excludeOptedOut: true, excludeUnreachable: true },
      body_template: 'permanent',
    });
    await broadcasts.markSending(sent.broadcastId, { 'c-1': { status: 'queued' } });
    await broadcasts.markSent(sent.broadcastId);
    const refused = await broadcasts.delete(sent.broadcastId);
    expect(refused).toEqual({ deleted: false, reason: 'not_draft' });
    expect(await broadcasts.getById(sent.broadcastId)).toBeDefined();
  });

  it('setSeedContactIds: replaces the seeds on a draft; a non-draft is refused (ConditionalCheckFailed)', async () => {
    const draft = await broadcasts.create({
      created_by: 'usr_test',
      audience_filter: { contact_type: 'tenant', excludeOptedOut: true, excludeUnreachable: true },
      body_template: 'seedable',
    });
    // Replace on a draft: the conditional (status='draft') passes.
    const set = await broadcasts.setSeedContactIds(draft.broadcastId, ['c-1', 'c-2']);
    expect(set.seed_contact_ids).toEqual(['c-1', 'c-2']);
    expect((await broadcasts.getById(draft.broadcastId))?.seed_contact_ids).toEqual(['c-1', 'c-2']);

    // An EMPTY array clears the list (valid — unlike create).
    const cleared = await broadcasts.setSeedContactIds(draft.broadcastId, []);
    expect(cleared.seed_contact_ids).toEqual([]);

    // A non-draft (sending) is refused by the status condition.
    await broadcasts.markSending(draft.broadcastId, { 'c-1': { status: 'queued' } });
    await expect(broadcasts.setSeedContactIds(draft.broadcastId, ['c-3'])).rejects.toBeInstanceOf(
      ConditionalCheckFailedException,
    );
  });

  it('conditional delete race: status flips draft→sending before the delete → not_draft, NO silent delete', async () => {
    // The real race: read sees a draft, but a concurrent send flips it to
    // 'sending' before the conditional DeleteCommand commits. We reproduce it
    // for real against DynamoDB Local by flipping the status (markSending) and
    // THEN issuing the conditional delete — the condition (status='draft') must
    // fail, leaving the now-sending broadcast intact.
    const b = await broadcasts.create({
      created_by: 'usr_test',
      audience_filter: { contact_type: 'tenant', excludeOptedOut: true, excludeUnreachable: true },
      body_template: 'raced',
    });
    await broadcasts.markSending(b.broadcastId, { 'c-1': { status: 'queued' } }); // the concurrent send won
    const result = await broadcasts.delete(b.broadcastId);
    expect(result).toEqual({ deleted: false, reason: 'not_draft' });
    // The broadcast was NOT silently deleted — it is still present and sending.
    const after = await broadcasts.getById(b.broadcastId);
    expect(after).toBeDefined();
    expect(after?.status).toBe('sending');
  });

  // --- claimFanoutPass: the durable fan-out pass counter (M5, spec D1-D6) ---
  //
  // The continuation ladders used to count passes in the ENQUEUED ENVELOPE, so a
  // broken queue froze the count and the cap-and-close branch was unreachable.
  // The count now lives on the durable item as a TOP-LEVEL scalar claimed by a
  // conditional ADD before the work it authorises. What only a real DynamoDB can
  // prove, and what these cases are here for: the ADD is atomic under
  // concurrency, the cap is a ConditionExpression rather than a read-then-write,
  // and a refused claim is disambiguated `capped` vs `missing` by a STRONGLY
  // consistent read (both repos' plain getters are eventually consistent).

  /** A fresh draft broadcast with NO fanout_attempt (a pre-branch row). */
  async function seedBroadcast(): Promise<string> {
    const created = await broadcasts.create({
      created_by: 'usr_test',
      audience_filter: { contact_type: 'tenant', excludeOptedOut: true, excludeUnreachable: true },
      body_template: 'fan-out claim',
    });
    return created.broadcastId;
  }

  /** A relay INBOUND source message with NO fanout_attempt (a pre-branch row). */
  async function seedSourceMessage(): Promise<{ conversationId: string; tsMsgId: string }> {
    const conversationId = `conv-claim-${randomUUID().slice(0, 8)}`;
    const providerTs = new Date().toISOString();
    const providerSid = `SM${randomUUID().slice(0, 12)}`;
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
    return { conversationId, tsMsgId: appended.tsMsgId };
  }

  /** Plant an exact counter value (a raw write - no repo method sets it). */
  async function setStoredFanoutAttempt(
    table: string,
    key: Record<string, string>,
    value: number,
  ): Promise<void> {
    await doc.send(
      new UpdateCommand({
        TableName: table,
        Key: key,
        UpdateExpression: 'SET #fa = :n',
        ExpressionAttributeNames: { '#fa': 'fanout_attempt' },
        ExpressionAttributeValues: { ':n': value },
      }),
    );
  }

  /** Read the persisted counter back STRONGLY consistently. */
  async function readStoredFanoutAttempt(
    table: string,
    key: Record<string, string>,
  ): Promise<number | undefined> {
    const { Item } = await doc.send(
      new GetCommand({ TableName: table, Key: key, ConsistentRead: true }),
    );
    return (Item as { fanout_attempt?: number } | undefined)?.fanout_attempt;
  }

  it('broadcasts.claimFanoutPass: an item written BEFORE this branch (no fanout_attempt) claims at 1 - D4, spec 7.8', async () => {
    const broadcastId = await seedBroadcast();
    expect(await broadcasts.claimFanoutPass(broadcastId, 3)).toEqual({
      outcome: 'claimed',
      attempt: 1,
    });
    // ADD creates the attribute from absent: no migration, no backfill, no
    // seeding step at the creation site.
    expect(await readStoredFanoutAttempt(broadcastsTable, { broadcastId })).toBe(1);
  });

  it('messages.claimFanoutPass: a source message written BEFORE this branch (no fanout_attempt) claims at 1 - D4, spec 7.8', async () => {
    const { conversationId, tsMsgId } = await seedSourceMessage();
    expect(await messages.claimFanoutPass(conversationId, tsMsgId, 3)).toEqual({
      outcome: 'claimed',
      attempt: 1,
    });
    expect(await readStoredFanoutAttempt(messagesTable, { conversationId, tsMsgId })).toBe(1);
  });

  it('broadcasts.claimFanoutPass: at cap-1 the LAST pass is claimed; at cap the claim is refused with the unchanged count', async () => {
    const broadcastId = await seedBroadcast();
    await setStoredFanoutAttempt(broadcastsTable, { broadcastId }, 2);
    expect(await broadcasts.claimFanoutPass(broadcastId, 3)).toEqual({
      outcome: 'claimed',
      attempt: 3,
    });
    expect(await broadcasts.claimFanoutPass(broadcastId, 3)).toEqual({
      outcome: 'capped',
      attempt: 3,
    });
    // The refused claim must not have advanced the counter (the cap is a
    // ConditionExpression, so the ADD never ran).
    expect(await readStoredFanoutAttempt(broadcastsTable, { broadcastId })).toBe(3);
  });

  it('messages.claimFanoutPass: at cap-1 the LAST pass is claimed; at cap the claim is refused with the unchanged count', async () => {
    const { conversationId, tsMsgId } = await seedSourceMessage();
    await setStoredFanoutAttempt(messagesTable, { conversationId, tsMsgId }, 2);
    expect(await messages.claimFanoutPass(conversationId, tsMsgId, 3)).toEqual({
      outcome: 'claimed',
      attempt: 3,
    });
    expect(await messages.claimFanoutPass(conversationId, tsMsgId, 3)).toEqual({
      outcome: 'capped',
      attempt: 3,
    });
    expect(await readStoredFanoutAttempt(messagesTable, { conversationId, tsMsgId })).toBe(3);
  });

  it('broadcasts.claimFanoutPass: a MISSING broadcast returns `missing`, never `capped`', async () => {
    // The two refusals are the SAME ConditionalCheckFailedException; only the
    // consistent re-read tells them apart, and the caller closes differently.
    expect(await broadcasts.claimFanoutPass(`bcast-${randomUUID()}`, 3)).toEqual({
      outcome: 'missing',
    });
  });

  it('messages.claimFanoutPass: a MISSING source message returns `missing`, never `capped`', async () => {
    const { conversationId } = await seedSourceMessage();
    // Same partition, a tsMsgId never written: the existence predicate is
    // attribute_exists(tsMsgId) - the RANGE key - so this is a missing ITEM,
    // not a live conversation.
    expect(await messages.claimFanoutPass(conversationId, '9999-01-01T00:00:00.000Z#SMnope', 3)).toEqual({
      outcome: 'missing',
    });
    expect(
      await messages.claimFanoutPass(`conv-absent-${randomUUID().slice(0, 8)}`, 'ts#SMnope', 3),
    ).toEqual({ outcome: 'missing' });
  });

  it('broadcasts.claimFanoutPass: 8 CONCURRENT claims take 8 DISTINCT pass numbers, exactly 1..8 - D5, spec 7.2', async () => {
    const broadcastId = await seedBroadcast();
    const results = await Promise.all(
      Array.from({ length: 8 }, () => broadcasts.claimFanoutPass(broadcastId, 8)),
    );
    expect(results.every((r) => r.outcome === 'claimed')).toBe(true);
    const attempts = results
      .map((r) => (r.outcome === 'missing' ? -1 : r.attempt))
      .sort((a, b) => a - b);
    expect(new Set(attempts).size).toBe(8);
    expect(attempts).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(await readStoredFanoutAttempt(broadcastsTable, { broadcastId })).toBe(8);
  });

  it('messages.claimFanoutPass: 8 CONCURRENT claims take 8 DISTINCT pass numbers, exactly 1..8 - D5, spec 7.2', async () => {
    const { conversationId, tsMsgId } = await seedSourceMessage();
    const results = await Promise.all(
      Array.from({ length: 8 }, () => messages.claimFanoutPass(conversationId, tsMsgId, 8)),
    );
    expect(results.every((r) => r.outcome === 'claimed')).toBe(true);
    const attempts = results
      .map((r) => (r.outcome === 'missing' ? -1 : r.attempt))
      .sort((a, b) => a - b);
    expect(new Set(attempts).size).toBe(8);
    expect(attempts).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(await readStoredFanoutAttempt(messagesTable, { conversationId, tsMsgId })).toBe(8);
  });

  it('broadcasts.claimFanoutPass: the count SURVIVES a wholesale recipient-slot write (setRecipient) - D2, spec 7.1', async () => {
    // setRecipient is the write that matters: `SET recipients.#ck = :rec`
    // replaces the WHOLE slot, so a counter living inside a slot would be erased
    // on every pass and read 1 forever - the exact no-op D2 forbids.
    const broadcastId = await seedBroadcast();
    await broadcasts.markSending(broadcastId, { 'c-1': { status: 'queued' } });
    expect(await broadcasts.claimFanoutPass(broadcastId, 3)).toEqual({
      outcome: 'claimed',
      attempt: 1,
    });
    expect(await broadcasts.setRecipient(broadcastId, 'c-1', { status: 'sent' })).toBe(true);
    expect(await readStoredFanoutAttempt(broadcastsTable, { broadcastId })).toBe(1);
  });

  it('messages.claimFanoutPass: the count SURVIVES a wholesale recipient-slot write (setRecipientDelivery) - D2, spec 7.1', async () => {
    // setRecipientDelivery, NOT updateRecipientDeliveryStatus. The latter writes
    // CHILD FIELDS only (delivery_recipients.#mk.#st = :s and friends), so a
    // slot-resident counter would SURVIVE it and this test would pass against
    // the very design D2 rules out. Only the wholesale slot SET proves it.
    const { conversationId, tsMsgId } = await seedSourceMessage();
    expect(await messages.claimFanoutPass(conversationId, tsMsgId, 3)).toEqual({
      outcome: 'claimed',
      attempt: 1,
    });
    await messages.setRecipientDelivery(conversationId, tsMsgId, 'c-bob', {
      status: 'sent',
      sid: 'SMout-bob',
    });
    expect(await readStoredFanoutAttempt(messagesTable, { conversationId, tsMsgId })).toBe(1);
  });

  // --- SOR Task 6: the broadcast-side send-outcome additions ----------------
  //
  // One conditional write per recipient outcome (slot + stats together), the
  // unconfirmed bucket, and the finalize flip only ONE writer wins (spec D8,
  // D16a, D22). No shared seeded broadcast: each case creates its own and
  // marks it sending (build finding T6-2).
  describe('SOR send-outcome additions: broadcast slots, stats and finalize', () => {
    async function sendingBroadcast(recipients: Record<string, BroadcastRecipient>): Promise<string> {
      const created = await broadcasts.create({
        created_by: 'usr_test',
        audience_filter: { contact_type: 'tenant', excludeOptedOut: true, excludeUnreachable: true },
        body_template: 'Hi [TenantName]',
      });
      await broadcasts.markSending(created.broadcastId, recipients);
      return created.broadcastId;
    }

    it('recordRecipientOutcome writes the slot and bumps stats in ONE conditional write', async () => {
      const id = await sendingBroadcast({ 'c-1': { status: 'queued' } });
      const sent: BroadcastRecipient = { status: 'sent', conversationId: 'conv-1', tsMsgId: 'ts-1' };
      const r = await broadcasts.recordRecipientOutcome(id, 'c-1', sent, { sent: 1, queued: -1 }, ['queued']);
      expect(r.moved).toBe(true);
      expect(r.item!.stats).toMatchObject({ sent: 1, queued: 0 });
      expect(r.item!.recipients['c-1']).toEqual(sent);
      const again = await broadcasts.recordRecipientOutcome(
        id,
        'c-1',
        { status: 'failed', errorCode: 'x' },
        { failed: 1, queued: -1 },
        ['queued'],
      );
      expect(again).toEqual({ moved: false });
      const stored = await broadcasts.getByIdConsistent(id);
      expect(stored!.stats).toMatchObject({ sent: 1, failed: 0, queued: 0 });
      expect(stored!.recipients['c-1']).toEqual(sent);
    });

    it('recordRecipientOutcome with a single-bucket delta lists only that bucket, and skips a zero delta', async () => {
      const id = await sendingBroadcast({ 'c-1': { status: 'queued' }, 'c-2': { status: 'queued' } });
      // An unused alias would be a ValidationException here.
      const r = await broadcasts.recordRecipientOutcome(id, 'c-1', { status: 'skipped', errorCode: 'opted_out' }, { skipped_opted_out: 1 }, ['queued']);
      expect(r.moved).toBe(true);
      expect(r.item!.stats).toMatchObject({ skipped_opted_out: 1, queued: 2 });
      const z = await broadcasts.recordRecipientOutcome(id, 'c-2', { status: 'sent' }, { sent: 1, failed: 0, queued: -1 }, ['queued']);
      expect(z.moved).toBe(true);
      expect(z.item!.stats).toMatchObject({ sent: 1, failed: 0, queued: 1 });
    });

    it('recordRecipientOutcome with an EMPTY delta writes the slot only, under the priors', async () => {
      const id = await sendingBroadcast({ 'c-1': { status: 'queued' } });
      const r = await broadcasts.recordRecipientOutcome(id, 'c-1', { status: 'queued', errorCode: 'send_retryable' }, {}, ['queued']);
      expect(r.moved).toBe(true);
      expect(r.item!.recipients['c-1']).toEqual({ status: 'queued', errorCode: 'send_retryable' });
      expect(r.item!.stats.queued).toBe(1); // untouched
      expect(
        await broadcasts.recordRecipientOutcome(id, 'c-1', { status: 'queued', errorCode: 'send_retryable' }, {}, ['sent']),
      ).toEqual({ moved: false });
    });

    it('recordRecipientOutcome refuses a missing slot and a missing broadcast, and rejects an empty prior list before any write', async () => {
      const id = await sendingBroadcast({ 'c-1': { status: 'queued' } });
      expect(
        await broadcasts.recordRecipientOutcome(id, 'c-absent', { status: 'sent' }, { sent: 1, queued: -1 }, ['queued']),
      ).toEqual({ moved: false });
      expect(
        await broadcasts.recordRecipientOutcome(`bcast-${randomUUID()}`, 'c-1', { status: 'sent' }, { sent: 1 }, ['queued']),
      ).toEqual({ moved: false });
      await expect(
        broadcasts.recordRecipientOutcome(id, 'c-1', { status: 'sent' }, { sent: 1 }, []),
      ).rejects.toThrow(TypeError);
      const stored = await broadcasts.getByIdConsistent(id);
      expect(stored!.recipients).toEqual({ 'c-1': { status: 'queued' } });
      expect(stored!.stats).toMatchObject({ sent: 0, queued: 1 });
    });

    it('closeRecipientIfQueued bumps the unconfirmed bucket, creating it on a legacy stats map', async () => {
      const id = await sendingBroadcast({ 'c-1': { status: 'queued' }, 'c-2': { status: 'queued' } });
      // create() persists `unconfirmed: 0` now; a share mid-send at deploy lacks it.
      await doc.send(
        new UpdateCommand({
          TableName: broadcastsTable,
          Key: { broadcastId: id },
          UpdateExpression: 'REMOVE stats.unconfirmed',
        }),
      );
      const { Item: stored } = await doc.send(
        new GetCommand({ TableName: broadcastsTable, Key: { broadcastId: id }, ConsistentRead: true }),
      );
      expect((stored as { stats: Record<string, unknown> }).stats).not.toHaveProperty('unconfirmed');
      const r = await broadcasts.closeRecipientIfQueued(id, 'c-1', 'send_unconfirmed', 'unconfirmed');
      expect(r.moved).toBe(true);
      expect(r.item!.stats).toMatchObject({ unconfirmed: 1, failed: 0, queued: 1 });
      expect(r.item!.recipients['c-1']).toEqual({ status: 'failed', errorCode: 'send_unconfirmed' });
      const f = await broadcasts.closeRecipientIfQueued(id, 'c-2', 'transient_cap', 'failed');
      expect(f.item!.stats).toMatchObject({ unconfirmed: 1, failed: 1, queued: 0 });
      expect(f.item!.recipients['c-2']).toEqual({ status: 'failed', errorCode: 'transient_cap' });
      expect(await broadcasts.closeRecipientIfQueued(id, 'c-1', 'send_unconfirmed', 'unconfirmed')).toEqual({ moved: false });
    });

    it('create persists the unconfirmed bucket at zero', async () => {
      const created = await broadcasts.create({
        created_by: 'usr_test',
        audience_filter: { contact_type: 'tenant', excludeOptedOut: true, excludeUnreachable: true },
        body_template: 'Hi [TenantName]',
      });
      expect((await broadcasts.getByIdConsistent(created.broadcastId))!.stats.unconfirmed).toBe(0);
    });

    it('finalizeStatus wins once from sending; a later call reads the item back; a draft never flips; a missing broadcast throws', async () => {
      const id = await sendingBroadcast({ 'c-1': { status: 'queued' } });
      const a = await broadcasts.finalizeStatus(id, 'sent');
      expect(a.won).toBe(true);
      expect(a.item).toMatchObject({ broadcastId: id, status: 'sent' });
      expect(a.item).not.toHaveProperty('last_error');
      const b = await broadcasts.finalizeStatus(id, 'failed', 'late');
      expect(b).toMatchObject({ won: false, item: { status: 'sent' } });
      expect(b.item).not.toHaveProperty('last_error');
      const failedId = await sendingBroadcast({ 'c-1': { status: 'queued' } });
      const lost = await broadcasts.finalizeStatus(failedId, 'failed', "Couldn't confirm any text went out");
      expect(lost).toMatchObject({ won: true, item: { status: 'failed', last_error: "Couldn't confirm any text went out" } });
      const draft = await broadcasts.create({
        created_by: 'usr_test',
        audience_filter: { contact_type: 'tenant', excludeOptedOut: true, excludeUnreachable: true },
        body_template: 'still a draft',
      });
      expect(await broadcasts.finalizeStatus(draft.broadcastId, 'sent')).toMatchObject({ won: false, item: { status: 'draft' } });
      await expect(broadcasts.finalizeStatus(`bcast-${randomUUID()}`, 'sent')).rejects.toThrow(/not found/);
    });

    it('finalizeStatus is safe against the SDK\'s replay: a flip that committed on an earlier attempt reports won to ITS caller; a second finalizer still loses (FW1-5, ADV-3)', async () => {
      const id = await sendingBroadcast({ 'c-1': { status: 'queued' } });
      // zz-adv-5's method: the Update commits, then fails the way the SDK's replay of it would.
      let replays = 1;
      const send = doc.send.bind(doc) as unknown as (cmd: unknown) => Promise<unknown>;
      const replaying = {
        async send(cmd: unknown) {
          const out = await send(cmd);
          if (replays > 0 && cmd instanceof UpdateCommand) {
            replays -= 1;
            throw new ConditionalCheckFailedException({ message: 'The conditional request failed', $metadata: {} });
          }
          return out;
        },
      } as unknown as typeof doc;
      const retried = createBroadcastsRepo({ doc: replaying, env: testEnv, logger });
      const won = await retried.finalizeStatus(id, 'failed', "Couldn't confirm any text went out");
      expect(replays).toBe(0);
      expect(won).toMatchObject({ won: true, item: { status: 'failed', last_error: "Couldn't confirm any text went out" } });
      const token = won.item['finalize_op'];
      expect(typeof token).toBe('string');
      // Any other finalizer - even through the same repo - is a genuine loser, and writes no token.
      expect(await broadcasts.finalizeStatus(id, 'sent')).toMatchObject({ won: false, item: { status: 'failed', finalize_op: token } });
      expect(await retried.finalizeStatus(id, 'sent')).toMatchObject({ won: false, item: { finalize_op: token } });
    });

    it('getByIdConsistent reads what getById reads', async () => {
      const id = await sendingBroadcast({ 'c-1': { status: 'queued' } });
      expect(await broadcasts.getByIdConsistent(id)).toEqual(await broadcasts.getById(id));
      expect(await broadcasts.getByIdConsistent(`bcast-${randomUUID()}`)).toBeUndefined();
    });
  });

  // --- SOR Task 6: the relay-side send-outcome additions --------------------
  //
  // The conditional closes, the forward-only adoption, the attempt clock and
  // the reporting SID claim the send sites and send.reconcile rest on (spec
  // D8, D8a, D11, D13, D15). Every case builds its OWN source row and SIDs:
  // this file's tables are shared by every case and never reset (build
  // finding T6-1).
  describe('SOR send-outcome additions: relay pointers and slots', () => {
    const T0 = '2026-09-26T12:00:00.000Z';
    const T1 = '2026-09-26T12:00:05.000Z';
    const relayCapture = createLogCapture();
    const relayMessages = createMessagesRepo({
      doc,
      env: testEnv,
      logger: createLogger({ level: 'info', destination: relayCapture.stream }),
    });

    /** A LEGACY relay inbound source (no transport schema version), seeded with an empty map. */
    async function legacySource(): Promise<{ conversationId: string; tsMsgId: string }> {
      const conversationId = `conv-relay-${randomUUID().slice(0, 8)}`;
      const appended = await relayMessages.append({
        conversationId,
        providerSid: `SM${randomUUID().slice(0, 12)}`,
        providerTs: new Date().toISOString(),
        type: 'sms',
        direction: 'inbound',
        author: 'unknown',
        deliveryStatus: 'delivered',
        relaySenderKey: 'c-alice',
        deliveryRecipients: {},
        body: 'is the unit still available?',
      });
      return { conversationId, tsMsgId: appended.tsMsgId };
    }

    /** A VERSIONED relay source (transport schema 1) with the given seeded slots. */
    async function versionedSource(
      slots: Record<string, RelayRecipientDelivery>,
    ): Promise<{ conversationId: string; tsMsgId: string }> {
      const conversationId = `conv-relay-${randomUUID().slice(0, 8)}`;
      const appended = await relayMessages.append({
        conversationId,
        providerSid: `SM${randomUUID().slice(0, 12)}`,
        providerTs: new Date().toISOString(),
        type: 'sms',
        direction: 'inbound',
        author: 'unknown',
        deliveryStatus: 'delivered',
        transportSchemaVersion: 1,
        relaySenderKey: 'c-alice',
        deliveryRecipients: slots,
        body: 'is the unit still available?',
      });
      return { conversationId, tsMsgId: appended.tsMsgId };
    }

    async function slotOf(
      src: { conversationId: string; tsMsgId: string },
      memberKey: string,
    ): Promise<RelayRecipientDelivery | undefined> {
      const row = await relayMessages.getByTsMsgIdConsistent(src.conversationId, src.tsMsgId);
      return row?.delivery_recipients?.[memberKey];
    }

    const planned: RelayRecipientDelivery = {
      status: 'queued',
      requestedTransport: 'sms',
      transportAggregationState: 'planned',
    };

    it('claimRelaySidPointer reports created / mine / other, and the consistent read returns the ref', async () => {
      const sid = `SMclaim${randomUUID().slice(0, 12)}`;
      const ref = { conversationId: `conv-${randomUUID().slice(0, 8)}`, tsMsgId: `${T0}#SMsrc`, memberKey: 'c-1' };
      expect(await relayMessages.getRelaySidPointerConsistent(sid)).toBeUndefined();
      expect(await relayMessages.claimRelaySidPointer(sid, ref)).toBe('created');
      expect(await relayMessages.claimRelaySidPointer(sid, { ...ref })).toBe('mine');
      expect(await relayMessages.claimRelaySidPointer(sid, { ...ref, memberKey: 'c-2' })).toBe('other');
      expect(await relayMessages.claimRelaySidPointer(sid, { ...ref, tsMsgId: `${T1}#SMsrc` })).toBe('other');
      expect(await relayMessages.claimRelaySidPointer(sid, { ...ref, conversationId: 'conv-else' })).toBe('other');
      // A lost claim never rewrites the pointer.
      expect(await relayMessages.getRelaySidPointerConsistent(sid)).toEqual(ref);
      expect(await relayMessages.getRelaySidPointer(sid)).toEqual(ref);
      // A pointer the existing put wrote is claimable as mine by the same ref.
      const putSid = `SMput${randomUUID().slice(0, 12)}`;
      await relayMessages.putRelaySidPointer(putSid, ref);
      expect(await relayMessages.claimRelaySidPointer(putSid, ref)).toBe('mine');
    });

    it('closeRelayRecipientIfUnsent closes an absent legacy slot and a queued sid-less slot, skips a queued slot with a sid, a terminal slot and a re-close, and reports a missing row', async () => {
      const src = await legacySource();
      const cap = { status: 'failed' as const, errorCode: 'transient_cap' };
      // Absent slot: a legacy source starts with an empty map (D8).
      expect(await relayMessages.closeRelayRecipientIfUnsent(src.conversationId, src.tsMsgId, 'c-1', cap)).toBe('closed');
      expect(await slotOf(src, 'c-1')).toEqual({ status: 'failed', errorCode: 'transient_cap' });
      // Queued with no sid: closed in place, the attempt clock kept.
      await relayMessages.setRecipientDelivery(src.conversationId, src.tsMsgId, 'c-2', { status: 'queued', attemptedAt: T0 });
      expect(await relayMessages.closeRelayRecipientIfUnsent(src.conversationId, src.tsMsgId, 'c-2', cap)).toBe('closed');
      expect(await slotOf(src, 'c-2')).toEqual({ status: 'failed', errorCode: 'transient_cap', attemptedAt: T0 });
      // Queued WITH a sid: the provider accepted it - never overwritten.
      await relayMessages.setRecipientDelivery(src.conversationId, src.tsMsgId, 'c-3', { status: 'queued', sid: 'SM7', sentAt: T0 });
      expect(await relayMessages.closeRelayRecipientIfUnsent(src.conversationId, src.tsMsgId, 'c-3', cap)).toBe('skipped_sent');
      expect(await slotOf(src, 'c-3')).toEqual({ status: 'queued', sid: 'SM7', sentAt: T0 });
      // A sent slot and a re-close of a closed slot are skipped too.
      await relayMessages.setRecipientDelivery(src.conversationId, src.tsMsgId, 'c-4', { status: 'sent', sid: 'SM8', sentAt: T0 });
      expect(await relayMessages.closeRelayRecipientIfUnsent(src.conversationId, src.tsMsgId, 'c-4', cap)).toBe('skipped_sent');
      expect(await relayMessages.closeRelayRecipientIfUnsent(src.conversationId, src.tsMsgId, 'c-1', { status: 'failed', errorCode: 'other' })).toBe('skipped_sent');
      expect(await slotOf(src, 'c-1')).toEqual({ status: 'failed', errorCode: 'transient_cap' });
      // No row at all.
      expect(await relayMessages.closeRelayRecipientIfUnsent(src.conversationId, `${T0}#SMnope`, 'c-1', cap)).toBe('missing');
    });

    it('closeRelayRecipientIfUnsent on a versioned row keeps requestedTransport and every sibling field, and is forward-only', async () => {
      const src = await versionedSource({ 'c-1': { ...planned } });
      const cap = { status: 'failed' as const, errorCode: 'transient_cap' };
      expect(await relayMessages.closeRelayRecipientIfUnsent(src.conversationId, src.tsMsgId, 'c-1', cap)).toBe('closed');
      expect(await slotOf(src, 'c-1')).toEqual({ ...planned, status: 'failed', errorCode: 'transient_cap' });
      expect(await relayMessages.closeRelayRecipientIfUnsent(src.conversationId, src.tsMsgId, 'c-1', { status: 'failed', errorCode: 'other' })).toBe('skipped_sent');
      expect(await slotOf(src, 'c-1')).toEqual({ ...planned, status: 'failed', errorCode: 'transient_cap' });
      // A member with no slot on a versioned row is created closed, like a legacy one.
      expect(await relayMessages.closeRelayRecipientIfUnsent(src.conversationId, src.tsMsgId, 'c-9', cap)).toBe('closed');
      expect(await slotOf(src, 'c-9')).toEqual({ status: 'failed', errorCode: 'transient_cap' });
    });

    it('setRelayRecipientAttemptedAt seeds an absent slot, never touches an existing slot\'s other fields, and is best-effort on a missing row', async () => {
      const src = await legacySource();
      await relayMessages.setRelayRecipientAttemptedAt(src.conversationId, src.tsMsgId, 'c-3', T0);
      expect(await slotOf(src, 'c-3')).toEqual({ status: 'queued', attemptedAt: T0 });
      await relayMessages.setRecipientDelivery(src.conversationId, src.tsMsgId, 'c-2', { status: 'queued', sid: 'SM7', sentAt: T0 });
      await relayMessages.setRelayRecipientAttemptedAt(src.conversationId, src.tsMsgId, 'c-2', T1);
      expect(await slotOf(src, 'c-2')).toEqual({ status: 'queued', sid: 'SM7', sentAt: T0, attemptedAt: T1 });
      // A later attempt stamps its own clock.
      await relayMessages.setRelayRecipientAttemptedAt(src.conversationId, src.tsMsgId, 'c-3', T1);
      expect(await slotOf(src, 'c-3')).toEqual({ status: 'queued', attemptedAt: T1 });
      // A versioned slot keeps its transport fields.
      const vsrc = await versionedSource({ 'c-1': { ...planned } });
      await relayMessages.setRelayRecipientAttemptedAt(vsrc.conversationId, vsrc.tsMsgId, 'c-1', T0);
      expect(await slotOf(vsrc, 'c-1')).toEqual({ ...planned, attemptedAt: T0 });
      // Best-effort: a missing row WARNs and resolves.
      const missingTs = `${T0}#SMnope${randomUUID().slice(0, 8)}`;
      await expect(
        relayMessages.setRelayRecipientAttemptedAt(src.conversationId, missingTs, 'c-1', T0),
      ).resolves.toBeUndefined();
      const warned = relayCapture.atLevel(40).filter((l) => l['tsMsgId'] === missingTs);
      expect(warned).toHaveLength(1);
      expect(warned[0]).toMatchObject({ conversationId: src.conversationId, memberKey: 'c-1' });
    });

    it('adoptRelayRecipientIfUnsent on a legacy row seeds an absent slot and is forward-only', async () => {
      const src = await legacySource();
      const adopt = (patch: { status: 'queued' | 'sent'; sid: string; sentAt: string; errorCode?: string }, memberKey = 'c-9', tsMsgId = src.tsMsgId) =>
        relayMessages.adoptRelayRecipientIfUnsent(src.conversationId, tsMsgId, memberKey, patch);
      expect(await adopt({ status: 'queued', sid: 'SM9', sentAt: T0 })).toBe('adopted'); // absent -> seeded -> adopted
      expect(await slotOf(src, 'c-9')).toEqual({ status: 'queued', sid: 'SM9', sentAt: T0 });
      expect(await adopt({ status: 'sent', sid: 'SM9', sentAt: T1 })).toBe('adopted');
      expect(await slotOf(src, 'c-9')).toEqual({ status: 'sent', sid: 'SM9', sentAt: T0 }); // the earlier sentAt is kept
      expect(await adopt({ status: 'queued', sid: 'SM9', sentAt: T1 })).toBe('skipped'); // sent -> queued is a regression
      expect((await slotOf(src, 'c-9'))?.status).toBe('sent');
      expect(await adopt({ status: 'sent', sid: 'SM9', sentAt: T1 })).toBe('adopted'); // same status: idempotent
      expect(await relayMessages.updateRecipientDeliveryStatus(src.conversationId, src.tsMsgId, 'c-9', 'delivered')).toBe(true);
      expect(await adopt({ status: 'sent', sid: 'SM9', sentAt: T1 })).toBe('skipped'); // a raced receipt is never regressed
      expect((await slotOf(src, 'c-9'))?.status).toBe('delivered');
      // First write wins on the sid; an error code rides a terminal adoption.
      await relayMessages.setRecipientDelivery(src.conversationId, src.tsMsgId, 'c-8', { status: 'queued', sid: 'SMold', attemptedAt: T0 });
      expect(
        await relayMessages.adoptRelayRecipientIfUnsent(src.conversationId, src.tsMsgId, 'c-8', { status: 'failed', sid: 'SMnew', sentAt: T1, errorCode: '30007' }),
      ).toBe('adopted');
      expect(await slotOf(src, 'c-8')).toEqual({ status: 'failed', sid: 'SMold', sentAt: T1, errorCode: '30007', attemptedAt: T0 });
      expect(await adopt({ status: 'sent', sid: 'SM9', sentAt: T1 }, 'c-9', `${T0}#SMnope`)).toBe('missing');
    });

    it('adoptRelayRecipientIfUnsent on a versioned row adopts once and skips the re-run and a regression', async () => {
      const src = await versionedSource({ 'c-1': { ...planned } });
      const patch = { status: 'sent' as const, sid: 'SM1', sentAt: T0 };
      expect(await relayMessages.adoptRelayRecipientIfUnsent(src.conversationId, src.tsMsgId, 'c-1', patch)).toBe('adopted');
      expect(await slotOf(src, 'c-1')).toEqual({ ...planned, status: 'sent', sid: 'SM1', sentAt: T0 });
      expect(await relayMessages.adoptRelayRecipientIfUnsent(src.conversationId, src.tsMsgId, 'c-1', patch)).toBe('skipped');
      expect(
        await relayMessages.adoptRelayRecipientIfUnsent(src.conversationId, src.tsMsgId, 'c-1', { ...patch, status: 'queued' }),
      ).toBe('skipped');
      expect((await slotOf(src, 'c-1'))?.status).toBe('sent');
      // A versioned member with no slot is missing - the fan-out preflight always seeds one.
      expect(await relayMessages.adoptRelayRecipientIfUnsent(src.conversationId, src.tsMsgId, 'c-absent', patch)).toBe('missing');
    });

    it('a row with NO delivery map: close and adopt answer missing and the attempt clock only WARNs - never a ValidationException', async () => {
      // No relay source row is written without the map today (build report
      // S1c, row shapes), but a nested SET under an absent map is a
      // ValidationException, not a condition failure - so the guard is
      // load-bearing, as the unguarded setRecipientDelivery shows.
      const conversationId = `conv-relay-${randomUUID().slice(0, 8)}`;
      const appended = await relayMessages.append({
        conversationId,
        providerSid: `SM${randomUUID().slice(0, 12)}`,
        providerTs: new Date().toISOString(),
        type: 'sms',
        direction: 'inbound',
        author: 'unknown',
        deliveryStatus: 'delivered',
        relaySenderKey: 'c-alice',
        body: 'no delivery map on this row',
      });
      const src = { conversationId, tsMsgId: appended.tsMsgId };
      await expect(
        relayMessages.setRecipientDelivery(conversationId, appended.tsMsgId, 'c-1', { status: 'queued' }),
      ).rejects.toMatchObject({ name: 'ValidationException' });
      expect(
        await relayMessages.closeRelayRecipientIfUnsent(conversationId, appended.tsMsgId, 'c-1', { status: 'failed', errorCode: 'transient_cap' }),
      ).toBe('missing');
      expect(
        await relayMessages.adoptRelayRecipientIfUnsent(conversationId, appended.tsMsgId, 'c-1', { status: 'sent', sid: 'SM1', sentAt: T0 }),
      ).toBe('missing');
      await expect(
        relayMessages.setRelayRecipientAttemptedAt(conversationId, appended.tsMsgId, 'c-1', T0),
      ).resolves.toBeUndefined();
      const row = await relayMessages.getByTsMsgIdConsistent(src.conversationId, src.tsMsgId);
      expect(row).toBeDefined();
      expect(row).not.toHaveProperty('delivery_recipients');
    });

    it('the consistent reads exist and agree with their eventual twins', async () => {
      const absent = `SMabsent${randomUUID().slice(0, 12)}`;
      expect(await relayMessages.getByProviderSidConsistent(absent)).toBeUndefined();
      expect(await relayMessages.getSystemSidMarkerConsistent(absent)).toBeUndefined();
      const src = await legacySource();
      const row = await relayMessages.getByTsMsgIdConsistent(src.conversationId, src.tsMsgId);
      expect(await relayMessages.getByProviderSidConsistent(row!.provider_sid)).toEqual(row);
      expect(await relayMessages.getByProviderSidConsistent(row!.provider_sid)).toEqual(
        await relayMessages.getByProviderSid(row!.provider_sid),
      );
      const marked = `SMsys${randomUUID().slice(0, 12)}`;
      await relayMessages.putSystemSidMarker(marked, 'cell_verification');
      expect(await relayMessages.getSystemSidMarkerConsistent(marked)).toEqual({ kind: 'cell_verification' });
      expect(await relayMessages.getSystemSidMarkerConsistent(marked)).toEqual(await relayMessages.getSystemSidMarker(marked));
      expect(await relayMessages.listByConversationConsistent(src.conversationId, { limit: 5 })).toEqual(
        await relayMessages.listByConversation(src.conversationId, { limit: 5 }),
      );
      expect(await relayMessages.listByConversationConsistent(src.conversationId)).toEqual([row]);
      expect(await relayMessages.listByConversationConsistent(src.conversationId, { before: src.tsMsgId })).toEqual([]);
    });

    it('every read a consistent twin makes carries ConsistentRead; the eventual reads never do (D11)', async () => {
      // DynamoDB Local answers every read consistently, so only the request
      // itself can show which read a method asked for.
      const sent: Array<Record<string, unknown>> = [];
      const recordingDoc = {
        send: (command: { input: Record<string, unknown> }) => {
          sent.push(command.input);
          return doc.send(command as never);
        },
      } as unknown as typeof doc;
      const m = createMessagesRepo({ doc: recordingDoc, env: testEnv, logger });
      const b = createBroadcastsRepo({ doc: recordingDoc, env: testEnv, logger });
      const reads = async (fn: () => Promise<unknown>): Promise<unknown[]> => {
        sent.length = 0;
        await fn();
        return sent.map((input) => input['ConsistentRead']);
      };
      const src = await legacySource();
      const row = await relayMessages.getByTsMsgIdConsistent(src.conversationId, src.tsMsgId);
      const sid = row!.provider_sid;
      await relayMessages.claimRelaySidPointer(sid, { ...src, memberKey: 'c-1' });
      await relayMessages.putSystemSidMarker(sid, 'cell_verification');
      const created = await broadcasts.create({
        created_by: 'usr_test',
        audience_filter: { contact_type: 'tenant', excludeOptedOut: true, excludeUnreachable: true },
        body_template: 'Hi [TenantName]',
      });
      expect(await reads(() => m.getByProviderSidConsistent(sid))).toEqual([true, true]);
      expect(await reads(() => m.getByProviderSid(sid))).toEqual([undefined, undefined]);
      expect(await reads(() => m.listByConversationConsistent(src.conversationId))).toEqual([true]);
      expect(await reads(() => m.listByConversation(src.conversationId))).toEqual([undefined]);
      expect(await reads(() => m.getRelaySidPointerConsistent(sid))).toEqual([true]);
      expect(await reads(() => m.getRelaySidPointer(sid))).toEqual([undefined]);
      expect(await reads(() => m.getSystemSidMarkerConsistent(sid))).toEqual([true]);
      expect(await reads(() => m.getSystemSidMarker(sid))).toEqual([undefined]);
      expect(await reads(() => b.getByIdConsistent(created.broadcastId))).toEqual([true]);
      expect(await reads(() => b.getById(created.broadcastId))).toEqual([undefined]);
      // A lost claim, a refused close and a lost finalize each decide from a
      // CONSISTENT read-back.
      expect(await reads(() => m.claimRelaySidPointer(sid, { ...src, memberKey: 'c-1' }))).toEqual([undefined, true]);
      await relayMessages.setRecipientDelivery(src.conversationId, src.tsMsgId, 'c-2', { status: 'sent', sid: 'SM2' });
      expect(
        await reads(() => m.closeRelayRecipientIfUnsent(src.conversationId, src.tsMsgId, 'c-2', { status: 'failed', errorCode: 'x' })),
      ).toEqual([undefined, undefined, true]);
      expect(await reads(() => b.finalizeStatus(created.broadcastId, 'sent'))).toEqual([undefined, true]);
    });
  });
});
