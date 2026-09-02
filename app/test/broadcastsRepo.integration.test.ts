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

  it('priorRecipientContactIds: unions recipients KEYS of sent/sending only (NOT draft/failed)', async () => {
    const unitId = `unit-${randomUUID().slice(0, 8)}`;

    // SENT broadcast for the unit → recipients counted.
    const sent = await broadcasts.create({
      created_by: 'usr_test',
      audience_filter: { contact_type: 'tenant', excludeOptedOut: true, excludeUnreachable: true },
      body_template: 'sent',
      unitId,
    });
    await broadcasts.markSending(sent.broadcastId, {
      'c-1': { status: 'queued' },
      'c-2': { status: 'queued' },
    });
    await broadcasts.markSent(sent.broadcastId);

    // SENDING broadcast for the unit → recipients counted (union).
    const sending = await broadcasts.create({
      created_by: 'usr_test',
      audience_filter: { contact_type: 'tenant', excludeOptedOut: true, excludeUnreachable: true },
      body_template: 'sending',
      unitId,
    });
    await broadcasts.markSending(sending.broadcastId, { 'c-3': { status: 'queued' } });

    // DRAFT broadcast for the unit → recipients NOT counted.
    const draft = await broadcasts.create({
      created_by: 'usr_test',
      audience_filter: { contact_type: 'tenant', excludeOptedOut: true, excludeUnreachable: true },
      body_template: 'draft',
      unitId,
    });
    // Force a recipients map onto the draft via a direct write would need the
    // repo; instead mark→sending→failed so it leaves recipients but a failed
    // status (also excluded).
    const failed = await broadcasts.create({
      created_by: 'usr_test',
      audience_filter: { contact_type: 'tenant', excludeOptedOut: true, excludeUnreachable: true },
      body_template: 'failed',
      unitId,
    });
    await broadcasts.markSending(failed.broadcastId, { 'c-9': { status: 'queued' } });
    await broadcasts.markFailed(failed.broadcastId, 'forced');
    expect(draft.status).toBe('draft'); // sanity: the bare draft stays out

    const prior = await broadcasts.priorRecipientContactIds(unitId);
    expect([...prior].sort()).toEqual(['c-1', 'c-2', 'c-3'].sort()); // c-9 (failed) excluded
  });

  it('priorRecipientContactIds: a unit with no sent/sending broadcasts → empty set', async () => {
    const unitId = `unit-${randomUUID().slice(0, 8)}`;
    await broadcasts.create({
      created_by: 'usr_test',
      audience_filter: { contact_type: 'tenant', excludeOptedOut: true, excludeUnreachable: true },
      body_template: 'just-a-draft',
      unitId,
    });
    const prior = await broadcasts.priorRecipientContactIds(unitId);
    expect(prior.size).toBe(0);
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
});
