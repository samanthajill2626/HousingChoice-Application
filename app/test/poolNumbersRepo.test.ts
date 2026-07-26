// SLICE 2 (T2) integration tests against DynamoDB Local - the pool_numbers repo's
// new `warming` lifecycle: createWarming / promoteToActive / listWarming /
// findWarmingBySid (D2 correlation by PN SID) / countFreshSpares (D7 burn-safe) /
// countWarming.
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
    `[poolNumbersRepo] SKIPPED - no DynamoDB Local at ${endpoint}. ` +
      'Run `npm run db:start` to exercise this suite.',
  );
}

describe.skipIf(!reachable)(
  'poolNumbersRepo warming lifecycle (DynamoDB Local, throwaway prefix)',
  () => {
    const testEnv = { TABLE_PREFIX: `hc-test-${randomUUID().slice(0, 8)}-` };
    const client = createDynamoClient({ endpoint });
    const doc = createDocumentClient({ endpoint });
    const logger = createLogger({ destination: createLogCapture().stream });
    const poolNumbers = createPoolNumbersRepo({ doc, env: testEnv, logger });

    beforeAll(async () => {
      await ensureTable(client, getTableSpec('pool_numbers'), tableName('pool_numbers', testEnv));
    }, 120_000);

    afterAll(async () => {
      await deleteTableIfExists(client, tableName('pool_numbers', testEnv));
      doc.destroy();
      client.destroy();
    }, 120_000);

    // Unique-ish generators so tests never collide (within-file + across runs).
    const poolPn = (p: string) => `${p}${Math.floor(Math.random() * 9000 + 1000)}`;
    const uniqSid = () => `PN${randomUUID().replace(/-/g, '')}`;

    it('createWarming writes lifecycle_state=warming + warming_started_at + sid (empty burn)', async () => {
      const pn = poolPn('+1555080');
      const sid = uniqSid();
      const before = new Date().toISOString();
      const item = await poolNumbers.createWarming({
        poolNumber: pn,
        sid,
        voiceCapable: true,
        smsCapable: true,
        provisionedVia: 'twilio',
      });
      expect(item.lifecycle_state).toBe('warming');
      expect(item.sid).toBe(sid);
      expect(typeof item.warming_started_at).toBe('string');
      expect(item.warming_started_at! >= before).toBe(true);

      const stored = await poolNumbers.get(pn);
      expect(stored?.lifecycle_state).toBe('warming');
      expect(stored?.sid).toBe(sid);
      expect(typeof stored?.warming_started_at).toBe('string');
      // Empty burn: DynamoDB forbids empty string sets - the attr is simply absent.
      expect(stored?.burned_phones).toBeUndefined();
      // No connecting tag unless a conversationId was given.
      expect(stored?.pending_conversation_id).toBeUndefined();
    });

    it('createWarming with a conversationId persists pending_conversation_id (the connecting tag)', async () => {
      const pn = poolPn('+1555081');
      const conv = `conv-${randomUUID().slice(0, 8)}`;
      await poolNumbers.createWarming({
        poolNumber: pn,
        sid: uniqSid(),
        voiceCapable: true,
        smsCapable: true,
        provisionedVia: 'twilio',
        conversationId: conv,
      });
      expect((await poolNumbers.get(pn))?.pending_conversation_id).toBe(conv);
    });

    it('a warming number is NOT returned by listActive and NOT claimable by burnClaim', async () => {
      const pn = poolPn('+1555082');
      await poolNumbers.createWarming({
        poolNumber: pn,
        sid: uniqSid(),
        voiceCapable: true,
        smsCapable: true,
        provisionedVia: 'console',
      });
      // Excluded from the reuse candidate set (listActive delegates to 'active').
      expect((await poolNumbers.listActive()).map((i) => i.poolNumber)).not.toContain(pn);
      // burnClaim conditions on lifecycle_state='active' - a warming number is refused.
      expect(await poolNumbers.burnClaim(pn, ['+15551180001'])).toBeUndefined();
      // ...and stays warming (the refused claim never mutated it).
      expect((await poolNumbers.get(pn))!.lifecycle_state).toBe('warming');
    });

    it('promoteToActive flips warming->active (true), is idempotent (second call false), REMOVEs warming_started_at', async () => {
      const pn = poolPn('+1555083');
      await poolNumbers.createWarming({
        poolNumber: pn,
        sid: uniqSid(),
        voiceCapable: true,
        smsCapable: true,
        provisionedVia: 'console',
      });
      expect(await poolNumbers.promoteToActive(pn)).toBe(true);
      const promoted = await poolNumbers.get(pn);
      expect(promoted?.lifecycle_state).toBe('active');
      expect(promoted?.warming_started_at).toBeUndefined(); // REMOVEd on promote
      // A redelivered registration event: the second promote is a no-op -> false.
      expect(await poolNumbers.promoteToActive(pn)).toBe(false);
      // The number is now a normal active number - it enters the reuse set.
      expect((await poolNumbers.listActive()).map((i) => i.poolNumber)).toContain(pn);
    });

    it('promoteToActive keeps pending_conversation_id intact (the webhook reads it pre-promote)', async () => {
      const pn = poolPn('+1555084');
      const conv = `conv-${randomUUID().slice(0, 8)}`;
      await poolNumbers.createWarming({
        poolNumber: pn,
        sid: uniqSid(),
        voiceCapable: true,
        smsCapable: true,
        provisionedVia: 'console',
        conversationId: conv,
      });
      expect(await poolNumbers.promoteToActive(pn)).toBe(true);
      expect((await poolNumbers.get(pn))!.pending_conversation_id).toBe(conv);
    });

    it('promoteToActive REFUSES a non-warming number (returns false; never fabricates a record)', async () => {
      // An active number: not warming -> promote refused.
      const active = poolPn('+1555085');
      await poolNumbers.create({
        poolNumber: active,
        voiceCapable: true,
        smsCapable: true,
        provisionedVia: 'console',
        burn: [],
      });
      expect(await poolNumbers.promoteToActive(active)).toBe(false);
      // A MISSING number: still false (conditional update on a non-existent item),
      // and no phantom record is created.
      const missing = poolPn('+1555086');
      expect(await poolNumbers.promoteToActive(missing)).toBe(false);
      expect(await poolNumbers.get(missing)).toBeUndefined();
    });

    it('listWarming returns ONLY warming rows (and includes a freshly-warmed number)', async () => {
      const warm = poolPn('+1555087');
      const active = poolPn('+1555088');
      await poolNumbers.createWarming({
        poolNumber: warm,
        sid: uniqSid(),
        voiceCapable: true,
        smsCapable: true,
        provisionedVia: 'console',
      });
      await poolNumbers.create({
        poolNumber: active,
        voiceCapable: true,
        smsCapable: true,
        provisionedVia: 'console',
        burn: [],
      });
      const warming = await poolNumbers.listWarming();
      const warmingPns = warming.map((i) => i.poolNumber);
      expect(warmingPns).toContain(warm);
      expect(warmingPns).not.toContain(active);
      // Cross-test-safe invariant: the partition returns ONLY warming rows.
      expect(warming.every((i) => i.lifecycle_state === 'warming')).toBe(true);
    });

    it('findWarmingBySid returns the matching warming record; undefined for an unknown sid', async () => {
      const pn = poolPn('+1555089');
      const sid = uniqSid();
      await poolNumbers.createWarming({
        poolNumber: pn,
        sid,
        voiceCapable: true,
        smsCapable: true,
        provisionedVia: 'console',
      });
      const found = await poolNumbers.findWarmingBySid(sid);
      expect(found?.poolNumber).toBe(pn);
      expect(found?.sid).toBe(sid);
      // An unknown sid resolves to undefined (a D2 correlation miss).
      expect(await poolNumbers.findWarmingBySid(uniqSid())).toBeUndefined();
    });

    it('findWarmingBySid does NOT match a promoted (now active) number - only warming is searched', async () => {
      const pn = poolPn('+1555090');
      const sid = uniqSid();
      await poolNumbers.createWarming({
        poolNumber: pn,
        sid,
        voiceCapable: true,
        smsCapable: true,
        provisionedVia: 'console',
      });
      await poolNumbers.promoteToActive(pn);
      // Once promoted it leaves the warming set - the SID no longer correlates.
      expect(await poolNumbers.findWarmingBySid(sid)).toBeUndefined();
    });

    it('countFreshSpares counts active+empty-burn+no-pending ONLY (not warming, not burned, not pending-tagged)', async () => {
      const before = await poolNumbers.countFreshSpares();
      // +1: a plain fresh spare (active, empty burn, no pending tag).
      await poolNumbers.create({
        poolNumber: poolPn('+1555091'),
        voiceCapable: true,
        smsCapable: true,
        provisionedVia: 'console',
        burn: [],
      });
      // NOT counted: a burned active (has burn history).
      await poolNumbers.create({
        poolNumber: poolPn('+1555092'),
        voiceCapable: true,
        smsCapable: true,
        provisionedVia: 'console',
        burn: ['+15551190001'],
      });
      // NOT counted: a warming number.
      await poolNumbers.createWarming({
        poolNumber: poolPn('+1555093'),
        sid: uniqSid(),
        voiceCapable: true,
        smsCapable: true,
        provisionedVia: 'console',
      });
      // NOT counted: a promoted-but-not-yet-assigned CONNECTING number (active +
      // empty burn + pending_conversation_id) - momentarily active but NOT a free
      // spare (D7 addendum).
      const pend = poolPn('+1555094');
      await poolNumbers.createWarming({
        poolNumber: pend,
        sid: uniqSid(),
        voiceCapable: true,
        smsCapable: true,
        provisionedVia: 'console',
        conversationId: `conv-${randomUUID().slice(0, 8)}`,
      });
      await poolNumbers.promoteToActive(pend);
      const after = await poolNumbers.countFreshSpares();
      expect(after - before).toBe(1);
    });

    it('countWarming counts warming ONLY (delta of exactly the warming rows added)', async () => {
      const before = await poolNumbers.countWarming();
      await poolNumbers.createWarming({
        poolNumber: poolPn('+1555095'),
        sid: uniqSid(),
        voiceCapable: true,
        smsCapable: true,
        provisionedVia: 'console',
      });
      await poolNumbers.createWarming({
        poolNumber: poolPn('+1555096'),
        sid: uniqSid(),
        voiceCapable: true,
        smsCapable: true,
        provisionedVia: 'console',
      });
      // An active number in the same window does NOT bump the warming count.
      await poolNumbers.create({
        poolNumber: poolPn('+1555097'),
        voiceCapable: true,
        smsCapable: true,
        provisionedVia: 'console',
        burn: [],
      });
      const after = await poolNumbers.countWarming();
      expect(after - before).toBe(2);
    });

    it('findByPendingConversationId returns WARMING and ACTIVE records earmarked to the conversation (not others)', async () => {
      const conv = `conv-${randomUUID().slice(0, 8)}`;
      const warmingPn = poolPn('+1555098');
      const activePn = poolPn('+1555099');
      const otherPn = poolPn('+1555100');
      // A warming number earmarked to conv.
      await poolNumbers.createWarming({
        poolNumber: warmingPn, sid: uniqSid(), voiceCapable: true, smsCapable: true,
        provisionedVia: 'console', conversationId: conv,
      });
      // An active number earmarked to conv (create threads conversationId -> pending).
      await poolNumbers.create({
        poolNumber: activePn, voiceCapable: true, smsCapable: true, provisionedVia: 'console',
        burn: [], conversationId: conv,
      });
      // A different active number NOT earmarked to conv.
      await poolNumbers.create({
        poolNumber: otherPn, voiceCapable: true, smsCapable: true, provisionedVia: 'console', burn: [],
      });

      const found = (await poolNumbers.findByPendingConversationId(conv))
        .map((r) => r.poolNumber)
        .sort();
      expect(found).toEqual([warmingPn, activePn].sort());
    });

    it('clearPendingConversation removes the earmark (idempotent; missing record swallowed)', async () => {
      const conv = `conv-${randomUUID().slice(0, 8)}`;
      const pn = poolPn('+1555101');
      await poolNumbers.create({
        poolNumber: pn, voiceCapable: true, smsCapable: true, provisionedVia: 'console',
        burn: [], conversationId: conv,
      });
      expect((await poolNumbers.get(pn))?.pending_conversation_id).toBe(conv);

      await poolNumbers.clearPendingConversation(pn);
      expect((await poolNumbers.get(pn))?.pending_conversation_id).toBeUndefined();
      // countFreshSpares now counts it (active + empty burn + no earmark).
      expect((await poolNumbers.findByPendingConversationId(conv))).toEqual([]);

      // Idempotent on an already-clear record, and a missing record is swallowed.
      await expect(poolNumbers.clearPendingConversation(pn)).resolves.toBeUndefined();
      await expect(
        poolNumbers.clearPendingConversation(poolPn('+1555102')),
      ).resolves.toBeUndefined();
    });
  },
);
