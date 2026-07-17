// M1.7 integration tests against DynamoDB Local — the relay repos' real GSI
// behavior: the conversations byPoolNumber GSI (sparse; relay routing key) and
// the pool_numbers byLifecycleState GSI (listActive + atomic burn-as-claim).
//
// Self-skipping like the other integration suites: when nothing answers at
// DYNAMODB_ENDPOINT (default http://localhost:8000) the suite is skipped so
// `npm test` stays green without Docker (`npm run db:start` to run for real).
import { randomUUID } from 'node:crypto';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tableName } from '../src/lib/config.js';
import { createDocumentClient, createDynamoClient } from '../src/lib/dynamo.js';
import { deleteTableIfExists, ensureTable } from '../src/lib/dynamoAdmin.js';
import { getTableSpec } from '../src/lib/tables.js';
import { createLogger } from '../src/lib/logger.js';
import { createConversationsRepo } from '../src/repos/conversationsRepo.js';
import { createPoolNumbersRepo } from '../src/repos/poolNumbersRepo.js';
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
    `[relayRepos.integration] SKIPPED — no DynamoDB Local at ${endpoint}. ` +
      'Run `npm run db:start` to exercise this suite.',
  );
}

describe.skipIf(!reachable)('relay repos against DynamoDB Local (throwaway prefix)', () => {
  const testEnv = { TABLE_PREFIX: `hc-test-${randomUUID().slice(0, 8)}-` };
  const client = createDynamoClient({ endpoint });
  const doc = createDocumentClient({ endpoint });
  const logger = createLogger({ destination: createLogCapture().stream });
  const repoDeps = { doc, env: testEnv, logger };

  const conversations = createConversationsRepo(repoDeps);
  const poolNumbers = createPoolNumbersRepo(repoDeps);

  const bases = ['conversations', 'pool_numbers'] as const;

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

  it('conversations.getByPoolNumber resolves the relay via the byPoolNumber GSI', async () => {
    const pool = `+1555040${Math.floor(Math.random() * 9000 + 1000)}`;
    const created = await conversations.createRelayGroup({
      poolNumber: pool,
      members: [{ contactId: 'c1', phone: '+15550100001', name: 'A' }],
      tag: 'fair',
    });
    const found = await conversations.getByPoolNumber(pool);
    expect(found?.conversationId).toBe(created.conversationId);
    expect(found?.type).toBe('relay_group');
  });

  it('byPoolNumber is sparse: a 1:1 conversation never indexes there', async () => {
    await conversations.createOrGetByParticipantPhone('+15550100099', 'unknown_1to1');
    // A pool-number lookup for a non-relay phone returns nothing.
    const found = await conversations.getByPoolNumber('+15550100099');
    expect(found).toBeUndefined();
  });

  it('close KEEPS pool_number; getAllByPoolNumber returns open + closed groups on one number', async () => {
    const pool = `+1555041${Math.floor(Math.random() * 9000 + 1000)}`;
    // Two groups multiplexed on ONE number (disjoint rosters).
    const closedGroup = await conversations.createRelayGroup({
      poolNumber: pool,
      members: [{ contactId: 'c1', phone: '+15550100002' }],
    });
    const openGroup = await conversations.createRelayGroup({
      poolNumber: pool,
      members: [{ contactId: 'c2', phone: '+15550100005' }],
    });
    // Close one; its pool_number is KEPT (burn-multiplexing - a closed group
    // stays resolvable so a late text can intercept to the sender's 1:1).
    await conversations.setRelayStatus(closedGroup.conversationId, 'closed', 'open');
    const closedAfter = await conversations.getById(closedGroup.conversationId);
    expect(closedAfter?.status).toBe('closed');
    expect(closedAfter?.pool_number).toBe(pool); // NEVER cleared now

    // byPoolNumber is a MULTI-match index: BOTH groups come back.
    const all = await conversations.getAllByPoolNumber(pool);
    const byId = new Map(all.map((c) => [c.conversationId, c]));
    expect(all).toHaveLength(2);
    expect(byId.get(closedGroup.conversationId)?.status).toBe('closed');
    expect(byId.get(openGroup.conversationId)?.status).toBe('open');
  });

  it('addMember/removeMember are idempotent on phone', async () => {
    const pool = `+1555042${Math.floor(Math.random() * 9000 + 1000)}`;
    const created = await conversations.createRelayGroup({
      poolNumber: pool,
      members: [{ contactId: 'c1', phone: '+15550100003' }],
    });
    await conversations.addMember(created.conversationId, { contactId: 'c2', phone: '+15550100004' });
    const dup = await conversations.addMember(created.conversationId, {
      contactId: 'c2',
      phone: '+15550100004',
    });
    expect(dup.participants).toHaveLength(2); // idempotent on phone
    const removed = await conversations.removeMember(created.conversationId, '+15550100004');
    expect(removed.participants).toHaveLength(1);
    const removedAgain = await conversations.removeMember(created.conversationId, '+15550100004');
    expect(removedAgain.participants).toHaveLength(1); // idempotent
  });

  it('FIX 3: concurrent addMember calls both land (optimistic-concurrency version guard, no silent clobber)', async () => {
    const pool = `+1555044${Math.floor(Math.random() * 9000 + 1000)}`;
    const created = await conversations.createRelayGroup({
      poolNumber: pool,
      members: [{ contactId: 'c1', phone: '+15550100010' }],
    });
    // Two DIFFERENT members added concurrently. Without the version guard the
    // read-modify-write would clobber: one add would be silently lost. With it,
    // the loser fails its conditional, re-reads, and retries — so BOTH land.
    await Promise.all([
      conversations.addMember(created.conversationId, { contactId: 'c2', phone: '+15550100011' }),
      conversations.addMember(created.conversationId, { contactId: 'c3', phone: '+15550100012' }),
    ]);
    const after = await conversations.getById(created.conversationId);
    expect(after?.participants).toHaveLength(3); // original + both concurrent adds
    expect(typeof after?.participants_version).toBe('number');
    expect((after?.participants_version ?? 0)).toBeGreaterThanOrEqual(2);
  });

  it('FIX 3: a concurrent add + remove of different phones both take effect', async () => {
    const pool = `+1555045${Math.floor(Math.random() * 9000 + 1000)}`;
    const created = await conversations.createRelayGroup({
      poolNumber: pool,
      members: [
        { contactId: 'c1', phone: '+15550100020' },
        { contactId: 'c2', phone: '+15550100021' },
      ],
    });
    await Promise.all([
      conversations.addMember(created.conversationId, { contactId: 'c3', phone: '+15550100022' }),
      conversations.removeMember(created.conversationId, '+15550100021'),
    ]);
    const after = await conversations.getById(created.conversationId);
    const phones = (after?.participants ?? []).map((p) => p.phone).sort();
    expect(phones).toEqual(['+15550100020', '+15550100022']); // c2 removed, c3 added
  });

  it('FIX 1: setRelayStatus is conditional on expectedCurrent (idempotent concurrent close)', async () => {
    const pool = `+1555046${Math.floor(Math.random() * 9000 + 1000)}`;
    const created = await conversations.createRelayGroup({
      poolNumber: pool,
      members: [{ contactId: 'c1', phone: '+15550100030' }],
    });
    // First close from 'open' succeeds.
    await conversations.setRelayStatus(created.conversationId, 'closed', 'open');
    // A second close conditioned on 'open' fails (already closed) - the caller
    // treats this as an idempotent no-op (no double action).
    const { ConditionalCheckFailedException } = await import('@aws-sdk/client-dynamodb');
    await expect(
      conversations.setRelayStatus(created.conversationId, 'closed', 'open'),
    ).rejects.toBeInstanceOf(ConditionalCheckFailedException);
  });

  // --- BUG 1: clearRelayMemberOptedOut is a safe no-op when the map is absent -
  // The common member-remove path clears the removed member's opt-out annotation.
  // When NO member ever opted out, `relay_opted_out_members` is ABSENT, and a
  // `REMOVE relay_opted_out_members.#mk` on a missing parent map is rejected by
  // DynamoDB (ValidationException — invalid document path). The fix guards the
  // REMOVE on the map existing and swallows the ConditionalCheckFailedException.
  it('BUG 1(a): clearRelayMemberOptedOut is a no-op when no opt-out map exists (no throw)', async () => {
    const pool = `+1555050${Math.floor(Math.random() * 9000 + 1000)}`;
    const created = await conversations.createRelayGroup({
      poolNumber: pool,
      members: [{ contactId: 'c1', phone: '+15550100200' }],
    });
    // No one has opted out → relay_opted_out_members is absent. Pre-fix this
    // threw "The document path provided in the update expression is invalid".
    await expect(
      conversations.clearRelayMemberOptedOut(created.conversationId, 'c1'),
    ).resolves.toBeUndefined();
    const after = await conversations.getById(created.conversationId);
    expect(after?.relay_opted_out_members).toBeUndefined(); // map never created
  });

  it('BUG 1(b): clearRelayMemberOptedOut removes an existing member entry', async () => {
    const pool = `+1555051${Math.floor(Math.random() * 9000 + 1000)}`;
    const created = await conversations.createRelayGroup({
      poolNumber: pool,
      members: [{ contactId: 'c1', phone: '+15550100201' }],
    });
    await conversations.setRelayMemberOptedOut(created.conversationId, 'c1', {
      contactId: 'c1',
      at: new Date().toISOString(),
    });
    await conversations.clearRelayMemberOptedOut(created.conversationId, 'c1');
    const after = await conversations.getById(created.conversationId);
    expect(after?.relay_opted_out_members?.['c1']).toBeUndefined(); // entry cleared
  });

  it('BUG 1(c): clearRelayMemberOptedOut is a no-op when the map exists but the key is absent', async () => {
    const pool = `+1555052${Math.floor(Math.random() * 9000 + 1000)}`;
    const created = await conversations.createRelayGroup({
      poolNumber: pool,
      members: [{ contactId: 'c1', phone: '+15550100202' }],
    });
    await conversations.setRelayMemberOptedOut(created.conversationId, 'c1', {
      contactId: 'c1',
      at: new Date().toISOString(),
    });
    // Clearing a DIFFERENT (absent) key must not throw and must leave c1 intact.
    await expect(
      conversations.clearRelayMemberOptedOut(created.conversationId, 'c2'),
    ).resolves.toBeUndefined();
    const after = await conversations.getById(created.conversationId);
    expect(after?.relay_opted_out_members?.['c1']).toBeDefined(); // c1 untouched
  });

  // --- BUG 2: open relay groups are NOT diluted out by open 1:1 volume --------
  // The pre-fix listRelayGroups walked the byLastActivity 'open' partition (EVERY
  // open conversation) with a `type = relay_group` FilterExpression. DynamoDB
  // applies FilterExpression AFTER Limit, so a relay group ordered behind more
  // open 1:1 threads than the page budget was never returned. The fix repoints
  // listRelayGroups to the sparse byRelayStatus GSI (relay groups ONLY), so the
  // 1:1 volume is irrelevant. This test reproduces the dilution at a SCALED
  // budget (Limit = the seeded 1:1 count), comparing the two query STRATEGIES
  // head-to-head against the same DynamoDB Local table.
  it('BUG 2: an open relay group behind >budget open 1:1s survives (GSI vs diluted byLastActivity)', async () => {
    // The relay group, timestamped OLDER than the 1:1 flood below.
    const pool = `+1555053${Math.floor(Math.random() * 9000 + 1000)}`;
    const relay = await conversations.createRelayGroup({
      poolNumber: pool,
      members: [{ contactId: 'cRelay', phone: '+15550100300' }],
    });
    await conversations.touchLastActivity(relay.conversationId, undefined, '2030-01-01T00:00:00.000Z');

    // Flood the 'open' partition with 1:1 conversations ALL more-recently-active
    // than the relay group (year 2099), each with a distinct timestamp so the
    // sort order is deterministic. This is the scaled stand-in for "more open
    // conversations than the page budget".
    const oneToOneCount = 30;
    for (let i = 0; i < oneToOneCount; i++) {
      const phone = `+1555806${String(1000 + i)}`;
      const conv = await conversations.createOrGetByParticipantPhone(phone, 'unknown_1to1');
      await conversations.touchLastActivity(
        conv.conversationId,
        undefined,
        `2099-01-01T00:00:${String(i).padStart(2, '0')}.000Z`,
      );
    }

    const relayTable = tableName('conversations', testEnv);

    // PRE-FIX STRATEGY: byLastActivity 'open' partition + post-Limit type filter,
    // budget = oneToOneCount. The newest `oneToOneCount` open convs are all 1:1s,
    // so the type filter (applied AFTER Limit) yields NOTHING — the relay group
    // is diluted out. This is exactly the bug.
    const diluted = await doc.send(
      new QueryCommand({
        TableName: relayTable,
        IndexName: 'byLastActivity',
        KeyConditionExpression: '#s = :status',
        FilterExpression: '#t = :relay',
        ExpressionAttributeNames: { '#s': 'status', '#t': 'type' },
        ExpressionAttributeValues: { ':status': 'open', ':relay': 'relay_group' },
        ScanIndexForward: false,
        Limit: oneToOneCount,
      }),
    );
    const dilutedIds = (diluted.Items ?? []).map((c) => c['conversationId']);
    expect(dilutedIds).not.toContain(relay.conversationId); // dropped by the filter

    // POST-FIX STRATEGY: the sparse byRelayStatus GSI holds relay groups ONLY, so
    // the same budget surfaces the relay group directly — immune to 1:1 volume.
    const viaGsi = await doc.send(
      new QueryCommand({
        TableName: relayTable,
        IndexName: 'byRelayStatus',
        KeyConditionExpression: '#rs = :rs',
        ExpressionAttributeNames: { '#rs': 'relay_status' },
        ExpressionAttributeValues: { ':rs': 'relay_group#open' },
        ScanIndexForward: false,
        Limit: oneToOneCount,
      }),
    );
    const gsiIds = (viaGsi.Items ?? []).map((c) => c['conversationId']);
    expect(gsiIds).toContain(relay.conversationId); // survives

    // And the repo method (now GSI-backed) surfaces it too.
    const { items } = await conversations.listRelayGroups('open');
    expect(items.map((c) => c.conversationId)).toContain(relay.conversationId);
  });

  it('pool_numbers: provisioned_via source tag round-trips on the item', async () => {
    const pn = `+1555047${Math.floor(Math.random() * 9000 + 1000)}`;
    await poolNumbers.create({
      poolNumber: pn,
      voiceCapable: true,
      smsCapable: true,
      provisionedVia: 'twilio',
      burn: [],
    });
    const stored = await poolNumbers.get(pn);
    expect(stored?.provisioned_via).toBe('twilio'); // flexible doc field, not a key/GSI attr
  });

  // --- pool_numbers burn model (real Sets + conditional-ADD races) -----------
  const poolPn = (p: string) => `${p}${Math.floor(Math.random() * 9000 + 1000)}`;

  it('create seeds burned_phones from the first roster and lands active', async () => {
    const pn = poolPn('+1555060');
    const item = await poolNumbers.create({
      poolNumber: pn, voiceCapable: true, smsCapable: true, provisionedVia: 'console',
      burn: ['+15551110001', '+15551110002'],
    });
    expect(item.lifecycle_state).toBe('active');
    const stored = await poolNumbers.get(pn);
    expect([...(stored!.burned_phones as Set<string>)].sort()).toEqual([
      '+15551110001', '+15551110002',
    ]);
  });

  it('create with an EMPTY roster writes NO burned_phones (empty sets are forbidden)', async () => {
    const pn = poolPn('+1555061');
    await poolNumbers.create({
      poolNumber: pn, voiceCapable: true, smsCapable: true, provisionedVia: 'console', burn: [],
    });
    expect((await poolNumbers.get(pn))!.burned_phones).toBeUndefined();
    // ...and a first burnClaim still succeeds (attribute_not_exists guard).
    expect(await poolNumbers.burnClaim(pn, ['+15551110020'])).toBeDefined();
  });

  it('burnClaim adds a disjoint roster and returns the updated item', async () => {
    const pn = poolPn('+1555062');
    await poolNumbers.create({
      poolNumber: pn, voiceCapable: true, smsCapable: true, provisionedVia: 'console',
      burn: ['+15551110001'],
    });
    const claimed = await poolNumbers.burnClaim(pn, ['+15551110003', '+15551110004']);
    expect(claimed).toBeDefined();
    expect([...(claimed!.burned_phones as Set<string>)].sort()).toEqual([
      '+15551110001', '+15551110003', '+15551110004',
    ]);
  });

  it('burnClaim REFUSES any overlap - even one phone (atomic: no partial add)', async () => {
    const pn = poolPn('+1555063');
    await poolNumbers.create({
      poolNumber: pn, voiceCapable: true, smsCapable: true, provisionedVia: 'console',
      burn: ['+15551110001', '+15551110002'],
    });
    expect(await poolNumbers.burnClaim(pn, ['+15551110009', '+15551110002'])).toBeUndefined();
    // The non-overlapping phone was NOT partially added.
    expect([...((await poolNumbers.get(pn))!.burned_phones as Set<string>)]).not.toContain(
      '+15551110009',
    );
  });

  it('burnClaim races: two overlapping claims on one number - exactly one wins', async () => {
    const pn = poolPn('+1555064');
    await poolNumbers.create({
      poolNumber: pn, voiceCapable: true, smsCapable: true, provisionedVia: 'console',
      burn: ['+15551119999'],
    });
    // True concurrency against DynamoDB Local: both share ...0006. The atomic
    // conditional ADD lets exactly one commit; the loser's condition fails.
    const [a, b] = await Promise.all([
      poolNumbers.burnClaim(pn, ['+15551110005', '+15551110006']),
      poolNumbers.burnClaim(pn, ['+15551110006', '+15551110007']),
    ]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
  });

  it('burnClaim refuses a released number', async () => {
    const pn = poolPn('+1555065');
    await poolNumbers.create({
      poolNumber: pn, voiceCapable: true, smsCapable: true, provisionedVia: 'console',
      burn: ['+15551110001'],
    });
    await poolNumbers.releaseNumber(pn);
    expect(await poolNumbers.burnClaim(pn, ['+15551119998'])).toBeUndefined();
  });

  it('noteGroupClosed keeps the max timestamp (monotonic; never regresses)', async () => {
    const pn = poolPn('+1555066');
    await poolNumbers.create({
      poolNumber: pn, voiceCapable: true, smsCapable: true, provisionedVia: 'console',
      burn: ['+15551110001'],
    });
    await poolNumbers.noteGroupClosed(pn, '2026-07-01T00:00:00.000Z');
    await poolNumbers.noteGroupClosed(pn, '2026-06-01T00:00:00.000Z'); // older - must not regress
    expect((await poolNumbers.get(pn))!.last_group_closed_at).toBe('2026-07-01T00:00:00.000Z');
  });

  it('noteGroupClosed on a MISSING pool record does not throw and WARNs distinctly (AF-11)', async () => {
    const capture = createLogCapture();
    const repo = createPoolNumbersRepo({
      doc,
      env: testEnv,
      logger: createLogger({ destination: capture.stream }),
    });
    const missing = poolPn('+1555099'); // never created
    // Best-effort: never throws even when the pool record is absent.
    await expect(repo.noteGroupClosed(missing, '2026-07-01T00:00:00.000Z')).resolves.toBeUndefined();
    // Distinct diagnostic: a MISSING record WARNs (not a silent swallow); the
    // line carries hasRecord:false only - never the number (PII).
    const WARN = 40;
    const warned = capture
      .atLevel(WARN)
      .find((l) => String(l['msg']).includes('pool record missing'));
    expect(warned).toBeDefined();
    expect(warned?.['hasRecord']).toBe(false);
  });

  it('releaseNumber flips active->released once; a second call returns undefined', async () => {
    const pn = poolPn('+1555067');
    await poolNumbers.create({
      poolNumber: pn, voiceCapable: true, smsCapable: true, provisionedVia: 'console',
      burn: ['+15551110001'],
    });
    expect(await poolNumbers.releaseNumber(pn)).toMatchObject({ lifecycle_state: 'released' });
    expect(await poolNumbers.releaseNumber(pn)).toBeUndefined();
  });

  it('listActive excludes released numbers', async () => {
    const a = poolPn('+1555068');
    const b = poolPn('+1555069');
    for (const p of [a, b]) {
      await poolNumbers.create({
        poolNumber: p, voiceCapable: true, smsCapable: true, provisionedVia: 'console',
        burn: [`${p}-x`],
      });
    }
    await poolNumbers.releaseNumber(b);
    const active = (await poolNumbers.listActive()).map((i) => i.poolNumber);
    expect(active).toContain(a);
    expect(active).not.toContain(b);
  });
});
