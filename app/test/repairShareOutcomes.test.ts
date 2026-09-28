// share-sent-outcome spec D8 against DynamoDB Local: the repair's census, then
// its apply - the chain's stamps (a missing root and a WRONG root), the decided
// attempt re-applied to its slot under the D2 rule (the delivered exception
// honored; a delivered or skipped slot never moved), the ledger rebuilt from
// the SLOT, the three traces of a chain that ended unresolved (a done/unresolved
// record, a reconciling record past the schedule, the row's retry_outcome),
// the unjudgeable slots left alone, idempotence (a second run reports zero
// *To* counters), the bulk Scan, the PARTIAL report on a read error, and the
// account guard before any read.
//
// Every fixture seeds through the REAL repos over this file's database (retry
// rows through messagesRepo.append, so their retrychild# pointers exist too)
// and every case runs in ONE-SHARE mode (`broadcastId`), so table-wide counts
// never leak between cases. Every fixture owns its unit `u-<id>`, its contact
// `c-<id>`, its conversation `conv-<id>` AND its provider SIDs: a SID is global
// (the sid# pointer dedupes it across conversations), so the ROOT / R1 / R2
// keys are minted per fixture (ids(id)).
//
// Self-skipping like the other DynamoDB Local suites; the per-file access key
// (test/setup/dynamoAccessKey.ts) gives this file its own database.
import { randomUUID } from 'node:crypto';
import { ConditionalCheckFailedException, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { tableName } from '../src/lib/config.js';
import { createDocumentClient, createDynamoClient } from '../src/lib/dynamo.js';
import { deleteTableIfExists, ensureTable } from '../src/lib/dynamoAdmin.js';
import { createLogger } from '../src/lib/logger.js';
import { RETRY_OUTCOME_UNCONFIRMED, RETRY_PROMISE_WITHDRAWN_AT } from '../src/lib/retrySendWindow.js';
import { bodyFingerprint, recipientDigest } from '../src/lib/sendFingerprint.js';
import { SEND_UNCONFIRMED_CODE } from '../src/lib/sendOutcome.js';
import { rowlessAttemptKey } from '../src/lib/shareAttemptOrder.js';
import { getTableSpec } from '../src/lib/tables.js';
import {
  createBroadcastsRepo,
  deriveBroadcastStats,
  zeroStats,
  type BroadcastItem,
  type BroadcastRecipient,
  type BroadcastStats,
} from '../src/repos/broadcastsRepo.js';
import { createListingSendsRepo } from '../src/repos/listingSendsRepo.js';
import { buildTsMsgId, createMessagesRepo, splitTsMsgId, type DeliveryStatus } from '../src/repos/messagesRepo.js';
import { createSendAttemptsRepo, type SendAttemptFacts, type SendAttemptOwner } from '../src/repos/sendAttemptsRepo.js';
import {
  parseRepairArgs,
  reportRepair,
  resolveTargetForRepair,
  runRepairShareOutcomes,
  UsageError,
  type RepairOptions,
} from '../scripts/repair-share-outcomes.js';
import { seedListingSend } from './helpers/listingSendSeed.js';
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
  console.warn(`[repairShareOutcomes] SKIPPED - no DynamoDB Local at ${endpoint}. Run \`npm run db:start\` to exercise this suite.`);
}

const NOW = Date.parse('2026-09-28T12:00:00.000Z');
const T_ROOT = '2026-09-28T11:00:00.000Z';
const T_R1 = '2026-09-28T11:01:00.000Z';
const T_R2 = '2026-09-28T11:02:00.000Z';
const MAIN = '+15550009999';
const PHONE = '+15550104242';
const BODY = 'A home for you - reply YES for a tour';
const BASES = ['broadcasts', 'messages', 'conversations', 'listing_sends'] as const;

/** The fixture's own ids: its unit, contact, conversation and message keys (a provider SID is global, so each share mints its own). */
function ids(id: string) {
  return {
    unitId: `u-${id}`,
    contactId: `c-${id}`,
    conversationId: `conv-${id}`,
    ROOT: buildTsMsgId(T_ROOT, `SM${id}-root`),
    R1: buildTsMsgId(T_R1, `SM${id}-r1`),
    R2: buildTsMsgId(T_R2, `SM${id}-r2`),
  };
}

interface RowSpec {
  tsMsgId: string;
  retryOf?: string;
  status: DeliveryStatus;
  errorCode?: string;
  /** broadcast_id + retry_root at append (a post-1b row); absent = a pre-1b row. */
  stamped?: boolean;
  /** Overrides the stamped retry_root (1b's walk stopped at its cap or a broken link). */
  wrongRoot?: string;
  /** The row's recipient_contact_id; default the fixture's contact, null = none. */
  recipientContactId?: string | null;
  retryAttempt?: number;
}

/** The report's zero shape (every counter a case does not name stays 0). */
const ZERO_UNJUDGEABLE = { originalMissing: 0, brokenLineage: 0, noContact: 0, noRecipientKey: 0 };

describe.skipIf(!reachable)('repair-share-outcomes (spec D8) against DynamoDB Local', () => {
  const testEnv = { TABLE_PREFIX: `hc-test-${randomUUID().slice(0, 8)}-` };
  const client = createDynamoClient({ endpoint });
  const doc = createDocumentClient({ endpoint });
  const capture = createLogCapture();
  const log = createLogger({ level: 'info', destination: capture.stream });
  const repoDeps = { doc, env: testEnv, logger: log };
  const broadcasts = createBroadcastsRepo(repoDeps);
  const messages = createMessagesRepo(repoDeps);
  const attempts = createSendAttemptsRepo(repoDeps);
  const listingSends = createListingSendsRepo(repoDeps);

  /** The required item fields every seeded share carries. */
  const baseShare = {
    created_by: 'usr_repair_test',
    created_at: '2026-09-28T10:59:00.000Z',
    audience_filter: { contact_type: 'tenant' as const, excludeOptedOut: true, excludeUnreachable: true },
    body_template: 'Hi [TenantName]',
  };

  function statsOf(recipients: Record<string, BroadcastRecipient>): BroadcastStats {
    const stats = { ...zeroStats(), audience: Object.keys(recipients).length };
    for (const slot of Object.values(recipients)) {
      if (slot.status === 'failed') {
        if (slot.errorCode === SEND_UNCONFIRMED_CODE) stats.unconfirmed = (stats.unconfirmed ?? 0) + 1;
        else stats.failed += 1;
      } else if (slot.status === 'skipped') stats.skipped_other = (stats.skipped_other ?? 0) + 1;
      else stats[slot.status] += 1;
    }
    return stats;
  }

  /** Seed one share item verbatim (a raw Put - the slots a case needs, no lifecycle walk). */
  async function putShare(
    item: Partial<BroadcastItem> & Pick<BroadcastItem, 'broadcastId' | 'recipients'>,
    env: { TABLE_PREFIX: string } = testEnv,
  ): Promise<void> {
    await doc.send(
      new PutCommand({
        TableName: tableName('broadcasts', env),
        Item: { ...baseShare, status: 'sent', stats: statsOf(item.recipients), ...item },
      }),
    );
  }

  /** One one-to-one conversation row (phone null = a thread with no participant_phone). */
  async function putConversation(conversationId: string, phone: string | null, env: { TABLE_PREFIX: string } = testEnv): Promise<void> {
    await doc.send(
      new PutCommand({
        TableName: tableName('conversations', env),
        Item: {
          conversationId,
          ...(phone !== null && { participant_phone: phone }),
          type: 'tenant_1to1',
          status: 'open',
          last_activity_at: T_ROOT,
          created_at: T_ROOT,
        },
      }),
    );
  }

  /** Append one outbound row through the REAL repo: an original carries broadcast_id and no retry_of; a retry carries retry_of and, when stamped, broadcast_id + retry_root. */
  async function appendRow(
    fixture: { conversationId: string; contactId: string; ROOT: string },
    broadcastId: string,
    row: RowSpec,
    repo: ReturnType<typeof createMessagesRepo> = messages,
  ): Promise<void> {
    const { providerTs, providerSid } = splitTsMsgId(row.tsMsgId);
    const recipient = row.recipientContactId === null ? undefined : (row.recipientContactId ?? fixture.contactId);
    const lineage =
      row.retryOf === undefined
        ? { broadcastId }
        : {
            retryOf: row.retryOf,
            ...(row.retryAttempt !== undefined && { retryAttempt: row.retryAttempt }),
            ...(row.stamped === true && { broadcastId, retryRoot: row.wrongRoot ?? fixture.ROOT }),
          };
    const res = await repo.append({
      conversationId: fixture.conversationId,
      providerSid,
      providerTs,
      type: 'sms',
      direction: 'outbound',
      author: 'teammate',
      body: BODY,
      deliveryStatus: row.status,
      ...(row.errorCode !== undefined && { errorCode: row.errorCode }),
      automated: true,
      ...(recipient !== undefined && { recipientContactId: recipient }),
      ...lineage,
    });
    expect(res.deduped).toBe(false);
  }

  /** The plan's fixture: a conversation `conv-<id>`, a share (unit `u-<id>`) with ONE slot on the original ROOT, and the rows appended in order. */
  async function seedShareWithChain(opts: {
    broadcastId: string;
    slotStatus: BroadcastRecipient['status'];
    slotAttempt?: string;
    slotKey?: string;
    phone?: string | null;
    rows: RowSpec[];
  }): Promise<void> {
    const k = ids(opts.broadcastId);
    await putConversation(k.conversationId, opts.phone === undefined ? PHONE : opts.phone);
    const slot: BroadcastRecipient = {
      status: opts.slotStatus,
      ...(opts.slotStatus === 'failed' && { errorCode: '30003' }),
      conversationId: k.conversationId,
      tsMsgId: k.ROOT,
      ...(opts.slotAttempt !== undefined && { latestAttempt: opts.slotAttempt }),
    };
    await putShare({ broadcastId: opts.broadcastId, unitId: k.unitId, recipients: { [opts.slotKey ?? k.contactId]: slot } });
    for (const row of opts.rows) await appendRow(k, opts.broadcastId, row);
  }

  /** ONE conversation (two contacts on one number): a share with two slots, both failed 30003 on their own originals, and a DELIVERED retry of O_b stamped with the share id (its root O_b). */
  async function seedTwoSlotShare(id: string) {
    const conversationId = `conv-${id}`;
    const a = `c-${id}-a`;
    const b = `c-${id}-b`;
    const oA = buildTsMsgId(T_ROOT, `SM${id}-oa`);
    const oB = buildTsMsgId('2026-09-28T11:00:01.000Z', `SM${id}-ob`);
    const rB = buildTsMsgId(T_R1, `SM${id}-rb`);
    await putConversation(conversationId, PHONE);
    await putShare({
      broadcastId: id,
      unitId: `u-${id}`,
      recipients: {
        [a]: { status: 'failed', errorCode: '30003', conversationId, tsMsgId: oA },
        [b]: { status: 'failed', errorCode: '30003', conversationId, tsMsgId: oB },
      },
    });
    await appendRow({ conversationId, contactId: a, ROOT: oA }, id, { tsMsgId: oA, status: 'failed', errorCode: '30003' });
    await appendRow({ conversationId, contactId: b, ROOT: oB }, id, { tsMsgId: oB, status: 'failed', errorCode: '30003' });
    await appendRow({ conversationId, contactId: b, ROOT: oB }, id, { tsMsgId: rB, retryOf: oB, status: 'delivered', stamped: true, retryAttempt: 1 });
    return { a, b, oA, oB, rB };
  }

  function factsFor(): SendAttemptFacts {
    const fp = bodyFingerprint(BODY);
    return { recipientDigest: recipientDigest(MAIN, PHONE), sender: MAIN, bodyHash: fp.hash, bodyShort: fp.short, mediaCount: 0 };
  }

  /** The retry_send record for attempt 1 of `retried` - claimed and handed to the reconcile at `at`; closed `unresolved` when asked (sendReconcile.test.ts's sequence). */
  async function retryRecord(k: ReturnType<typeof ids>, retried: string, recipientKey: string, at: string, close: boolean): Promise<void> {
    const owner: SendAttemptOwner = { kind: 'retry_send', conversationId: k.conversationId, retriedTsMsgId: retried, attempt: 1, recipientKey, retryRoot: k.ROOT };
    const claimed = await attempts.claim(owner, factsFor(), at);
    expect(claimed.outcome).toBe('claimed');
    const ref = { attemptNo: claimed.record.attemptNo, attemptedAt: claimed.record.attemptedAt };
    expect(await attempts.handToReconcile(owner, ref)).toBe(true);
    if (close) {
      expect(await attempts.closeFromReconcile(owner, ref.attemptedAt, { outcome: 'unresolved', cause: 'digest_mismatch' })).toBe(true);
    }
  }

  const slotOf = async (broadcastId: string, key = ids(broadcastId).contactId) =>
    (await broadcasts.getByIdConsistent(broadcastId))!.recipients![key]!;
  const ledgerOf = async (broadcastId: string) => listingSends.getByKeyConsistent(ids(broadcastId).unitId, ids(broadcastId).contactId);
  const run = (broadcastId: string, apply: boolean, extra: Partial<RepairOptions> = {}) =>
    runRepairShareOutcomes({ doc, env: testEnv, apply, now: () => NOW, broadcastId, logger: log, ...extra });

  beforeAll(async () => {
    for (const base of BASES) await ensureTable(client, getTableSpec(base), tableName(base, testEnv));
  }, 120_000);

  afterAll(async () => {
    for (const base of BASES) await deleteTableIfExists(client, tableName(base, testEnv));
    doc.destroy();
    client.destroy();
  }, 120_000);

  it('census: a share whose retry delivered (pre-1b rows: no broadcast_id, no retry_root) reports 1 stamp needed, 1 slot to move and 1 row to create; dry run writes nothing', async () => {
    const k = ids('b-1');
    await seedShareWithChain({ broadcastId: 'b-1', slotStatus: 'failed', rows: [{ tsMsgId: k.ROOT, status: 'failed', errorCode: '30003' }, { tsMsgId: k.R1, retryOf: k.ROOT, status: 'delivered' }] });
    const report = await run('b-1', false);
    expect(report).toMatchObject({ sharesWalked: 1, slotsWalked: 1, stampsNeeded: 1, stampsWritten: 0, slotsToMove: 1, slotsMoved: 0, rowsToCreate: 1, rowsCreated: 0, pairsToRecount: 1, pairsRecounted: 0 });
    expect((await slotOf('b-1')).status).toBe('failed');
    expect(await ledgerOf('b-1')).toBeUndefined();
    const r1 = await messages.getByTsMsgIdConsistent(k.conversationId, k.R1);
    expect(r1).not.toHaveProperty('broadcast_id');
    expect(r1).not.toHaveProperty('retry_root');
  });

  it("apply: stamps the chain, moves the slot to delivered as the newer attempt, creates the ledger row counted by delivery at the retry's instant, and a second run reports zeros", async () => {
    const k = ids('b-1');
    const first = await run('b-1', true);
    expect(first).toMatchObject({ stampsWritten: 1, slotsMoved: 1, rowsCreated: 1, pairsRecounted: 1 });
    expect(await messages.getByTsMsgIdConsistent(k.conversationId, k.R1)).toMatchObject({ broadcast_id: 'b-1', retry_root: k.ROOT });
    expect(await slotOf('b-1')).toMatchObject({ status: 'delivered', latestAttempt: k.R1 });
    expect(await ledgerOf('b-1')).toMatchObject({ counted: true, sentAt: '2026-09-28T11:01:00.000Z', broadcastId: 'b-1' });
    expect((await ledgerOf('b-1'))?.shares?.['b-1']).toMatchObject({ attempt: k.R1, state: 'counted', by: 'delivery' });
    const second = await run('b-1', true);
    expect(second).toMatchObject({ stampsNeeded: 0, slotsToMove: 0, rowsToCreate: 0, pairsToRecount: 0, pairsToUncount: 0 });
    expect(second).toMatchObject({ stampsWritten: 0, slotsMoved: 0, rowsCreated: 0, pairsRecounted: 0, pairsUncounted: 0, unjudgeable: ZERO_UNJUDGEABLE });
  });

  it('a post-1b row whose retry_root is WRONG (the hop cap) is corrected, and a chain with an unstamped ancestor is stamped end to end', async () => {
    const k = ids('b-2');
    await seedShareWithChain({
      broadcastId: 'b-2',
      slotStatus: 'failed',
      rows: [
        { tsMsgId: k.ROOT, status: 'failed', errorCode: '30003' },
        { tsMsgId: k.R1, retryOf: k.ROOT, status: 'failed', errorCode: '30003' },
        { tsMsgId: k.R2, retryOf: k.R1, status: 'delivered', stamped: true, wrongRoot: k.R1 },
      ],
    });
    const report = await run('b-2', true);
    expect(report).toMatchObject({ stampsNeeded: 2, stampsWritten: 2 });
    expect((await messages.getByTsMsgIdConsistent(k.conversationId, k.R2))?.retry_root).toBe(k.ROOT);
    expect(await messages.getByTsMsgIdConsistent(k.conversationId, k.R1)).toMatchObject({ broadcast_id: 'b-2', retry_root: k.ROOT });
    // The original is the slot's own row: never stamped with a root.
    expect(await messages.getByTsMsgIdConsistent(k.conversationId, k.ROOT)).not.toHaveProperty('retry_root');
    expect(await slotOf('b-2')).toMatchObject({ status: 'delivered', latestAttempt: k.R2 });
  });

  it('a DELIVERED older attempt decides even when a newer retry failed (the delivered exception); the ledger follows the slot', async () => {
    const k = ids('b-3');
    await seedShareWithChain({
      broadcastId: 'b-3',
      slotStatus: 'failed',
      rows: [
        { tsMsgId: k.ROOT, status: 'failed', errorCode: '30003' },
        { tsMsgId: k.R1, retryOf: k.ROOT, status: 'delivered' },
        { tsMsgId: k.R2, retryOf: k.R1, status: 'failed', errorCode: '30007' },
      ],
    });
    await run('b-3', true);
    expect(await slotOf('b-3')).toMatchObject({ status: 'delivered', latestAttempt: k.R1 });
    expect((await ledgerOf('b-3'))?.shares?.['b-3']).toMatchObject({ state: 'counted', by: 'delivery' });
  });

  it("a retry whose row reads sent (only the carrier's sent callback moves a row there) moves the slot carrier-CONFIRMED - carrierSentAt is the row's own provider instant - so the share derives it into sent, not sending; a queued row stays a bare acceptance", async () => {
    const k = ids('b-16');
    await seedShareWithChain({
      broadcastId: 'b-16',
      slotStatus: 'failed',
      rows: [
        { tsMsgId: k.ROOT, status: 'failed', errorCode: '30003' },
        { tsMsgId: k.R1, retryOf: k.ROOT, status: 'sent', stamped: true, retryAttempt: 1 },
      ],
    });
    expect(await run('b-16', true)).toMatchObject({ slotsMoved: 1 });
    expect(await slotOf('b-16')).toMatchObject({ status: 'sent', latestAttempt: k.R1, carrierSentAt: T_R1 });
    expect(deriveBroadcastStats((await broadcasts.getByIdConsistent('b-16'))!)).toMatchObject({ sent: 1, sending: 0, failed: 0 });
    expect((await ledgerOf('b-16'))?.shares?.['b-16']).toMatchObject({ attempt: k.R1, state: 'counted', by: 'acceptance' });

    const q = ids('b-16q');
    await seedShareWithChain({
      broadcastId: 'b-16q',
      slotStatus: 'failed',
      rows: [
        { tsMsgId: q.ROOT, status: 'failed', errorCode: '30003' },
        { tsMsgId: q.R1, retryOf: q.ROOT, status: 'queued', stamped: true, retryAttempt: 1 },
      ],
    });
    expect(await run('b-16q', true)).toMatchObject({ slotsMoved: 1 });
    expect(await slotOf('b-16q')).toMatchObject({ status: 'sent', latestAttempt: q.R1 });
    expect(await slotOf('b-16q')).not.toHaveProperty('carrierSentAt');
    expect(deriveBroadcastStats((await broadcasts.getByIdConsistent('b-16q'))!)).toMatchObject({ sent: 0, sending: 1 });
  });

  it('a slot stuck sent whose own row failed moves to failed and un-counts the pair (pairsUncounted 1); a delivered slot whose newest row lies is never to-move and keeps its counted entry; a skipped slot is never walked', async () => {
    const k4 = ids('b-4');
    await seedShareWithChain({ broadcastId: 'b-4', slotStatus: 'sent', rows: [{ tsMsgId: k4.ROOT, status: 'failed', errorCode: '30007' }] });
    await seedListingSend(listingSends, { unitId: k4.unitId, contactId: k4.contactId, sentAt: T_ROOT, broadcastId: 'b-4' }); // the fixture's OWN pair: nothing else counts it
    expect(await run('b-4', false)).toMatchObject({ slotsToMove: 1, pairsToUncount: 1 }); // the dry run forecasts the un-count
    expect(await run('b-4', true)).toMatchObject({ slotsMoved: 1, pairsUncounted: 1 });
    expect(await slotOf('b-4')).toMatchObject({ status: 'failed', errorCode: '30007' });
    expect(await ledgerOf('b-4')).toMatchObject({ counted: false });
    expect(await ledgerOf('b-4')).not.toHaveProperty('sentAt');

    const k5 = ids('b-5');
    await seedShareWithChain({ broadcastId: 'b-5', slotStatus: 'delivered', rows: [{ tsMsgId: k5.ROOT, status: 'failed', errorCode: '30007' }] });
    await seedListingSend(listingSends, { unitId: k5.unitId, contactId: k5.contactId, sentAt: T_ROOT, broadcastId: 'b-5' });
    expect(await run('b-5', false)).toMatchObject({ slotsToMove: 0, pairsToUncount: 0 }); // the dry run forecasts nothing: the rule refuses a delivered slot
    expect(await run('b-5', true)).toMatchObject({ slotsMoved: 0, pairsUncounted: 0 });
    expect((await slotOf('b-5')).status).toBe('delivered');
    expect(await ledgerOf('b-5')).toMatchObject({ counted: true, sentAt: T_ROOT });
    expect((await ledgerOf('b-5'))?.shares?.['b-5']).toMatchObject({ state: 'counted', by: 'delivery', attempt: k5.ROOT });

    await seedShareWithChain({ broadcastId: 'b-6', slotStatus: 'skipped', rows: [] });
    expect((await run('b-6', true)).slotsWalked).toBe(0);
  });

  it("a chain whose newest attempt's next-attempt record is done/unresolved marks the slot send_unconfirmed as a row-less attempt and the ledger entry unconfirmed", async () => {
    const k = ids('b-7');
    await seedShareWithChain({ broadcastId: 'b-7', slotStatus: 'failed', rows: [{ tsMsgId: k.ROOT, status: 'failed', errorCode: '30003' }] });
    // attempt 1 of the retry of ROOT, keyed by ROOT's recorded recipient (c-b-7), closed unresolved
    await retryRecord(k, k.ROOT, k.contactId, '2026-09-28T11:05:00.000Z', true);
    expect(await run('b-7', false)).toMatchObject({ slotsToMove: 1, rowsToCreate: 1, pairsToRecount: 0 });
    const report = await run('b-7', true);
    expect(report.slotsMoved).toBe(1);
    expect(await slotOf('b-7')).toMatchObject({ status: 'failed', errorCode: SEND_UNCONFIRMED_CODE, latestAttempt: rowlessAttemptKey(k.ROOT) });
    expect((await ledgerOf('b-7'))?.shares?.['b-7']?.state).toBe('unconfirmed');
    expect(await run('b-7', false)).toMatchObject({ slotsToMove: 0, rowsToCreate: 0 });
  });

  it("the chain's other two unresolved traces: a reconciling record past the reconcile's schedule with no chain row, and the newest row's retry_outcome; a YOUNG reconciling record decides nothing", async () => {
    const old = ids('b-7r');
    await seedShareWithChain({ broadcastId: 'b-7r', slotStatus: 'failed', rows: [{ tsMsgId: old.ROOT, status: 'failed', errorCode: '30003' }] });
    await retryRecord(old, old.ROOT, old.contactId, '2026-09-28T11:50:00.000Z', false); // 10 min before NOW: past 4 min + 2 min
    expect(await run('b-7r', true)).toMatchObject({ slotsToMove: 1, slotsMoved: 1 });
    expect(await slotOf('b-7r')).toMatchObject({ status: 'failed', errorCode: SEND_UNCONFIRMED_CODE, latestAttempt: rowlessAttemptKey(old.ROOT) });

    const young = ids('b-7y');
    await seedShareWithChain({ broadcastId: 'b-7y', slotStatus: 'failed', rows: [{ tsMsgId: young.ROOT, status: 'failed', errorCode: '30003' }] });
    await retryRecord(young, young.ROOT, young.contactId, '2026-09-28T11:58:00.000Z', false); // 2 min before NOW: the reconcile still owns it
    expect(await run('b-7y', true)).toMatchObject({ slotsToMove: 0, slotsMoved: 0 });
    expect(await slotOf('b-7y')).toMatchObject({ status: 'failed', errorCode: '30003' });

    const withdrawn = ids('b-7o');
    await seedShareWithChain({ broadcastId: 'b-7o', slotStatus: 'failed', rows: [{ tsMsgId: withdrawn.ROOT, status: 'failed', errorCode: '30003' }] });
    // 1b's WITHDRAW on the share's own root row (erratum 13) - no record at all.
    expect(
      await messages.annotateRetryPromise(withdrawn.conversationId, withdrawn.ROOT, { retryDueAt: RETRY_PROMISE_WITHDRAWN_AT, retryOutcome: RETRY_OUTCOME_UNCONFIRMED }, { retryDueAt: undefined }),
    ).toBe(true);
    expect(await run('b-7o', true)).toMatchObject({ slotsMoved: 1 });
    expect(await slotOf('b-7o')).toMatchObject({ status: 'failed', errorCode: SEND_UNCONFIRMED_CODE, latestAttempt: rowlessAttemptKey(withdrawn.ROOT) });
  });

  it("an original row that is missing is unjudgeable and untouched; a row that claims this original (retry_root) but does not walk to it is a broken lineage; another slot's chain in the same thread (same broadcast_id, another root) is ignored", async () => {
    const k8 = ids('b-8');
    await seedShareWithChain({ broadcastId: 'b-8', slotStatus: 'failed', rows: [] });
    // Review Focus 5: the slot AND its ledger row are left exactly as they are on --apply.
    await seedListingSend(listingSends, { unitId: k8.unitId, contactId: k8.contactId, sentAt: T_ROOT, broadcastId: 'b-8' });
    const slotBefore = await slotOf('b-8');
    const rowBefore = await ledgerOf('b-8');
    const r8 = await run('b-8', true);
    expect(r8.unjudgeable.originalMissing).toBe(1);
    expect(r8).toMatchObject({ slotsWalked: 1, stampsNeeded: 0, slotsToMove: 0, rowsToCreate: 0, pairsToRecount: 0, pairsToUncount: 0, rowsCreated: 0, pairsRecounted: 0, pairsUncounted: 0 });
    expect(await slotOf('b-8')).toStrictEqual(slotBefore);
    expect(await ledgerOf('b-8')).toStrictEqual(rowBefore);

    const k9 = ids('b-9');
    await seedShareWithChain({ broadcastId: 'b-9', slotStatus: 'failed', rows: [{ tsMsgId: k9.ROOT, status: 'failed', errorCode: '30003' }, { tsMsgId: k9.R1, retryOf: 'gone', status: 'delivered', stamped: true }] });
    const r9 = await run('b-9', true);
    expect(r9.unjudgeable.brokenLineage).toBe(1);
    expect(r9).toMatchObject({ stampsNeeded: 0, slotsToMove: 0, rowsToCreate: 0 });
    expect((await slotOf('b-9')).status).toBe('failed');
    expect(await ledgerOf('b-9')).toBeUndefined();

    // b-10: two slots on ONE conversation (two contacts, one number): b's chain rows carry broadcast_id b-10 but walk to
    // b's original; a's slot is judged from ITS chain only
    const two = await seedTwoSlotShare('b-10');
    const r = await run('b-10', true);
    expect(r.unjudgeable.brokenLineage).toBe(0);
    expect(r.slotsMoved).toBe(1); // b's retry delivered; a's chain is empty and its failed slot stands
    expect(await slotOf('b-10', two.b)).toMatchObject({ status: 'delivered', latestAttempt: two.rB });
    expect(await slotOf('b-10', two.a)).toMatchObject({ status: 'failed', errorCode: '30003' });
    expect(await slotOf('b-10', two.a)).not.toHaveProperty('latestAttempt');
  });

  it('a share with no unitId is not walked', async () => {
    await putShare({ broadcastId: 'b-11', unitId: undefined, recipients: { 'c-b-11': { status: 'failed', errorCode: '30003', conversationId: 'conv-x', tsMsgId: ids('b-11').ROOT } } });
    expect((await run('b-11', false)).sharesWalked).toBe(0);
  });

  it("a phone-keyed slot is matched by its conversation and original (never by the key) and its ledger lands on the row's recorded contact; with no contact and no thread number anywhere it counts noContact and noRecipientKey and stands on its rows; no line carries the number", async () => {
    const slotKey = `phone#${PHONE}`;
    const k = ids('b-15');
    await seedShareWithChain({ broadcastId: 'b-15', slotStatus: 'failed', slotKey, rows: [{ tsMsgId: k.ROOT, status: 'failed', errorCode: '30003' }, { tsMsgId: k.R1, retryOf: k.ROOT, status: 'delivered', retryAttempt: 1 }] });
    const n = ids('b-14');
    await seedShareWithChain({ broadcastId: 'b-14', slotStatus: 'failed', slotKey, phone: null, rows: [{ tsMsgId: n.ROOT, status: 'failed', errorCode: '30003', recipientContactId: null }] });
    const mark = capture.lines.length;

    expect(await run('b-15', true)).toMatchObject({ slotsMoved: 1, rowsCreated: 1, pairsRecounted: 1, unjudgeable: ZERO_UNJUDGEABLE });
    expect(await slotOf('b-15', slotKey)).toMatchObject({ status: 'delivered', latestAttempt: k.R1 });
    expect(await ledgerOf('b-15')).toMatchObject({ counted: true, broadcastId: 'b-15' });

    const r = await run('b-14', true);
    expect(r.unjudgeable).toStrictEqual({ originalMissing: 0, brokenLineage: 0, noContact: 1, noRecipientKey: 1 });
    expect(r).toMatchObject({ slotsWalked: 1, slotsToMove: 0, slotsMoved: 0, rowsToCreate: 0, rowsCreated: 0 });
    expect(await slotOf('b-14', slotKey)).toMatchObject({ status: 'failed', errorCode: '30003' });

    const lines = JSON.stringify(capture.lines.slice(mark));
    expect(lines).not.toContain(PHONE.slice(1));
    expect(lines).toContain('phone#redacted');
  });

  it('an unknown --broadcast id is a usage error (nothing ran); reportRepair logs the report and a completed run exits 0', async () => {
    await expect(run('b-nope', false)).rejects.toBeInstanceOf(UsageError);
    const k = ids('b-13');
    await seedShareWithChain({ broadcastId: 'b-13', slotStatus: 'failed', rows: [{ tsMsgId: k.ROOT, status: 'failed', errorCode: '30003' }, { tsMsgId: k.R1, retryOf: k.ROOT, status: 'delivered' }] });
    const report = await run('b-13', false);
    const mark = capture.lines.length;
    expect(reportRepair(report, false, log)).toBe(0);
    const done = capture.lines.slice(mark);
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({ level: 30, apply: false, sharesWalked: 1, slotsToMove: 1, slotsMoved: 0 });
    expect(String(done[0]!['msg'])).toContain('DRY RUN');
  });

  it('a read that fails aborts the run: the PARTIAL report is logged at ERROR first, then the error propagates', async () => {
    const k = ids('b-12');
    await seedShareWithChain({ broadcastId: 'b-12', slotStatus: 'failed', rows: [{ tsMsgId: k.ROOT, status: 'failed', errorCode: '30003' }, { tsMsgId: k.R1, retryOf: k.ROOT, status: 'delivered' }] });
    const failing = {
      send: async (command: { constructor: { name: string } }) => {
        if (command.constructor.name === 'QueryCommand') throw new Error('injected read failure');
        return await doc.send(command as never);
      },
      destroy: () => {},
    } as unknown as DynamoDBDocumentClient;
    const mark = capture.lines.length;
    await expect(run('b-12', true, { doc: failing })).rejects.toThrow('injected read failure');
    const errors = capture.lines.slice(mark).filter((l) => l['level'] === 50);
    expect(errors).toHaveLength(1);
    expect(String(errors[0]!['msg'])).toContain('PARTIAL');
    expect(errors[0]).toMatchObject({ apply: true, sharesWalked: 1, slotsWalked: 1, stampsWritten: 0, slotsMoved: 0 });
    // Nothing was written: the chain read failed before any stamp or slot write.
    expect((await slotOf('b-12')).status).toBe('failed');
    expect(await messages.getByTsMsgIdConsistent(k.conversationId, k.R1)).not.toHaveProperty('retry_root');
  });

  it('bulk mode (no --broadcast): ONE Scan of the broadcasts table, paged, filtered to unit-targeted shares - a unit-less share is never walked; the apply moves, and a re-run forecasts nothing', async () => {
    const env2 = { TABLE_PREFIX: `hc-test-${randomUUID().slice(0, 8)}-` };
    for (const base of BASES) await ensureTable(client, getTableSpec(base), tableName(base, env2));
    try {
      const messages2 = createMessagesRepo({ doc, env: env2, logger: log });
      const kA = ids('bulk-a');
      await putConversation(kA.conversationId, PHONE, env2);
      await putShare({ broadcastId: 'bulk-a', unitId: kA.unitId, recipients: { [kA.contactId]: { status: 'failed', errorCode: '30003', conversationId: kA.conversationId, tsMsgId: kA.ROOT } } }, env2);
      await appendRow(kA, 'bulk-a', { tsMsgId: kA.ROOT, status: 'failed', errorCode: '30003' }, messages2);
      await appendRow(kA, 'bulk-a', { tsMsgId: kA.R1, retryOf: kA.ROOT, status: 'delivered' }, messages2);
      const kB = ids('bulk-b');
      await putShare({ broadcastId: 'bulk-b', recipients: { [kB.contactId]: { status: 'failed', errorCode: '30003', conversationId: kB.conversationId, tsMsgId: kB.ROOT } } }, env2);
      const kC = ids('bulk-c');
      await putConversation(kC.conversationId, PHONE, env2);
      await putShare({ broadcastId: 'bulk-c', unitId: kC.unitId, recipients: { [kC.contactId]: { status: 'sent', conversationId: kC.conversationId, tsMsgId: kC.ROOT } } }, env2);
      await appendRow(kC, 'bulk-c', { tsMsgId: kC.ROOT, status: 'sent' }, messages2);

      const bulk = (apply: boolean) => runRepairShareOutcomes({ doc, env: env2, apply, now: () => NOW, scanLimit: 1, logger: log });
      expect(await bulk(false)).toMatchObject({ sharesWalked: 2, slotsWalked: 2, stampsNeeded: 1, slotsToMove: 1, rowsToCreate: 2, pairsToRecount: 2, unjudgeable: ZERO_UNJUDGEABLE });
      expect(await bulk(true)).toMatchObject({ sharesWalked: 2, stampsWritten: 1, slotsMoved: 1, rowsCreated: 2, pairsRecounted: 2 });
      expect(await bulk(false)).toMatchObject({ sharesWalked: 2, stampsNeeded: 0, slotsToMove: 0, rowsToCreate: 0, pairsToRecount: 0, pairsToUncount: 0 });
    } finally {
      for (const base of BASES) await deleteTableIfExists(client, tableName(base, env2));
    }
  });

  it("bulk mode: ONE share whose slot write fails permanently (DynamoDB's item-size limit) is named on ONE ERROR line and counted in slotsFailed; the walk goes on and repairs the shares after it in scan order; the full report is logged and the run exits 1; a re-run reports the same one failure and nothing else to do", async () => {
    const env3 = { TABLE_PREFIX: `hc-test-${randomUUID().slice(0, 8)}-` };
    for (const base of BASES) await ensureTable(client, getTableSpec(base), tableName(base, env3));
    try {
      const messages3 = createMessagesRepo({ doc, env: env3, logger: log });
      const broadcasts3 = createBroadcastsRepo({ doc, env: env3, logger: log });
      const slotOf3 = async (id: string) => (await broadcasts3.getByIdConsistent(id))!.recipients![ids(id).contactId]!;
      for (const id of ['big-a', 'big-b', 'big-c']) {
        const k = ids(id);
        await putConversation(k.conversationId, PHONE, env3);
        await putShare({ broadcastId: id, unitId: k.unitId, recipients: { [k.contactId]: { status: 'failed', errorCode: '30003', conversationId: k.conversationId, tsMsgId: k.ROOT } } }, env3);
        await appendRow(k, id, { tsMsgId: k.ROOT, status: 'failed', errorCode: '30003' }, messages3);
        await appendRow(k, id, { tsMsgId: k.R1, retryOf: k.ROOT, status: 'delivered', stamped: true, retryAttempt: 1 }, messages3);
      }
      // The table's own Scan order decides which share is walked FIRST: that one fails, so the other two come after it.
      const table = tableName('broadcasts', env3);
      const order = ((await doc.send(new ScanCommand({ TableName: table, ConsistentRead: true }))).Items ?? []).map((i) => String(i['broadcastId']));
      expect([...order].sort()).toEqual(['big-a', 'big-b', 'big-c']);
      const [failing, ...after] = order as [string, ...string[]];
      const tooBig = {
        send: async (command: { constructor: { name: string }; input: { TableName?: string; Key?: Record<string, unknown> } }) => {
          if (command.constructor.name === 'UpdateCommand' && command.input.TableName === table && command.input.Key?.['broadcastId'] === failing) {
            throw Object.assign(new Error('Item size to update has exceeded the maximum allowed size'), { name: 'ValidationException' });
          }
          return await doc.send(command as never);
        },
        destroy: () => {},
      } as unknown as DynamoDBDocumentClient;
      const bulk = () => runRepairShareOutcomes({ doc: tooBig, env: env3, apply: true, now: () => NOW, scanLimit: 1, logger: log });

      const mark = capture.lines.length;
      const first = await bulk();
      // The forecast counts every slot; the apply wrote every slot but the failing one.
      expect(first).toMatchObject({ sharesWalked: 3, slotsWalked: 3, slotsToMove: 3, slotsMoved: 2, rowsToCreate: 3, rowsCreated: 2, pairsToRecount: 3, pairsRecounted: 2, slotsFailed: 1 });
      for (const id of after) expect(await slotOf3(id)).toMatchObject({ status: 'delivered', latestAttempt: ids(id).R1 });
      expect(await slotOf3(failing)).toMatchObject({ status: 'failed', errorCode: '30003' });
      const runLines = capture.lines.slice(mark);
      const failed = runLines.filter((l) => l['level'] === 50 && String(l['msg']).includes('write failed for this slot'));
      expect(failed).toHaveLength(1);
      expect(failed[0]).toMatchObject({ broadcastId: failing, recipientKey: ids(failing).contactId, conversationId: ids(failing).conversationId, tsMsgId: ids(failing).ROOT, step: 'slot' });
      expect(String((failed[0]!['err'] as { message?: string }).message)).toContain('Item size');
      // The run did not abort.
      expect(runLines.filter((l) => String(l['msg']).includes('PARTIAL'))).toHaveLength(0);
      // The full report, then exit 1.
      const reportMark = capture.lines.length;
      expect(reportRepair(first, true, log)).toBe(1);
      const done = capture.lines.slice(reportMark);
      expect(done).toHaveLength(1);
      expect(done[0]).toMatchObject({ level: 40, apply: true, slotsFailed: 1, slotsMoved: 2 });
      expect(String(done[0]!['msg'])).toContain('COMPLETED WITH FAILURES');

      const againMark = capture.lines.length;
      const second = await bulk();
      expect(second).toMatchObject({ sharesWalked: 3, stampsNeeded: 0, slotsToMove: 1, slotsMoved: 0, rowsToCreate: 1, rowsCreated: 0, pairsToRecount: 1, pairsRecounted: 0, pairsToUncount: 0, slotsFailed: 1 });
      const again = capture.lines.slice(againMark).filter((l) => l['level'] === 50 && String(l['msg']).includes('write failed for this slot'));
      expect(again.map((l) => l['broadcastId'])).toEqual([failing]);
    } finally {
      for (const base of BASES) await deleteTableIfExists(client, tableName(base, env3));
    }
  });

  it("a slot write whose condition keeps losing past the re-read bound, and a ledger write that throws, are each counted in slotsFailed with ONE ERROR naming the share - never an abort", async () => {
    const slotTable = tableName('broadcasts', testEnv);
    const ledgerTable = tableName('listing_sends', testEnv);
    const lost = ids('b-17');
    await seedShareWithChain({ broadcastId: 'b-17', slotStatus: 'failed', rows: [{ tsMsgId: lost.ROOT, status: 'failed', errorCode: '30003' }, { tsMsgId: lost.R1, retryOf: lost.ROOT, status: 'delivered', stamped: true, retryAttempt: 1 }] });
    const ledger = ids('b-18');
    await seedShareWithChain({ broadcastId: 'b-18', slotStatus: 'failed', rows: [{ tsMsgId: ledger.ROOT, status: 'failed', errorCode: '30003' }, { tsMsgId: ledger.R1, retryOf: ledger.ROOT, status: 'delivered', stamped: true, retryAttempt: 1 }] });
    const faulty = {
      send: async (command: { constructor: { name: string }; input: { TableName?: string; Key?: Record<string, unknown> } }) => {
        if (command.constructor.name === 'UpdateCommand' && command.input.TableName === slotTable && command.input.Key?.['broadcastId'] === 'b-17') {
          throw new ConditionalCheckFailedException({ message: 'The conditional request failed', $metadata: {} });
        }
        if (command.constructor.name === 'UpdateCommand' && command.input.TableName === ledgerTable && command.input.Key?.['unitId'] === ledger.unitId) {
          throw new Error('injected ledger write failure');
        }
        return await doc.send(command as never);
      },
      destroy: () => {},
    } as unknown as DynamoDBDocumentClient;

    const mark = capture.lines.length;
    expect(await run('b-17', true, { doc: faulty })).toMatchObject({ slotsToMove: 1, slotsMoved: 0, rowsCreated: 0, slotsFailed: 1 });
    expect(await slotOf('b-17')).toMatchObject({ status: 'failed', errorCode: '30003' });
    expect(await ledgerOf('b-17')).toBeUndefined();
    const lostLines = capture.lines.slice(mark).filter((l) => l['level'] === 50 && String(l['msg']).includes('write failed for this slot'));
    expect(lostLines).toHaveLength(1);
    expect(lostLines[0]).toMatchObject({ broadcastId: 'b-17', tsMsgId: lost.ROOT, step: 'slot', result: 'lost' });

    const ledgerMark = capture.lines.length;
    expect(await run('b-18', true, { doc: faulty })).toMatchObject({ slotsMoved: 1, rowsCreated: 0, slotsFailed: 1 });
    expect(await slotOf('b-18')).toMatchObject({ status: 'delivered', latestAttempt: ledger.R1 });
    const ledgerLines = capture.lines.slice(ledgerMark).filter((l) => l['level'] === 50 && String(l['msg']).includes('write failed for this slot'));
    expect(ledgerLines).toHaveLength(1);
    expect(ledgerLines[0]).toMatchObject({ broadcastId: 'b-18', tsMsgId: ledger.ROOT, step: 'ledger' });
    expect(capture.lines.slice(mark).filter((l) => String(l['msg']).includes('PARTIAL'))).toHaveLength(0);
  });

  it('the CLI contract: --env local|dev|prod, --lane with local only, --broadcast <id>, --apply; anything else is a usage error', () => {
    const ok = parseRepairArgs(['--env', 'local', '--lane', '15', '--broadcast', 'b-1', '--apply']);
    expect(ok).toMatchObject({ target: 'local', lane: 15 });
    if ('usage' in ok) throw new Error('unreachable');
    expect(ok.values.get('--broadcast')).toBe('b-1');
    expect(ok.flags.has('--apply')).toBe(true);
    expect(parseRepairArgs(['--env', 'dev'])).toMatchObject({ target: 'dev', lane: undefined });
    for (const bad of [[], ['--env', 'dev', '--lane', '3'], ['--env', 'dev', '--dry-run'], ['--env', 'dev', '--broadcast'], ['--env', 'dev', '--apply', '--apply'], ['--env', 'staging']]) {
      expect(parseRepairArgs(bad)).toStrictEqual({ usage: true });
    }
  });

  it('the account guard: a dev/prod target whose identity is not the housingchoice account refuses BEFORE any read', async () => {
    const send = vi.spyOn(doc, 'send');
    // Any document or low-level client built along the way would send through these.
    const anyDocSend = vi.spyOn(DynamoDBDocumentClient.prototype, 'send');
    const anyRawSend = vi.spyOn(DynamoDBClient.prototype, 'send');
    try {
      await expect(resolveTargetForRepair('dev', { assertAccount: async () => ({ Account: '000000000000' }) })).rejects.toThrow(/ACCOUNT GUARD/);
      await expect(resolveTargetForRepair('prod', { assertAccount: async () => ({ Account: '000000000000' }) })).rejects.toThrow(/ACCOUNT GUARD/);
      expect(send).not.toHaveBeenCalled();
      expect(anyDocSend).not.toHaveBeenCalled();
      expect(anyRawSend).not.toHaveBeenCalled();
    } finally {
      send.mockRestore();
      anyDocSend.mockRestore();
      anyRawSend.mockRestore();
    }
  });
});
