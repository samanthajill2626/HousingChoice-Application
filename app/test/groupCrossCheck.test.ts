// T6.2 - the conversation cross-check.
//
// WHAT THIS IS. Group detection depends on `OtherRecipients{N}`, an UNDOCUMENTED
// Twilio webhook parameter. The failure that must be impossible is "detection
// silently stops and nobody knows why". The cross-check watches the SAME carrier
// group traffic through a second, independent channel - the service-scoped
// Conversations `onMessageAdded` - and alarms when a message that reached the
// Conversation never reached the classic webhook.
//
// WHAT THIS IS NOT. `onMessageAdded` carries no SM/MM identifier, so there is NO
// deterministic join with the classic inbound. This is a LIVENESS HEURISTIC:
// events and classic filings are matched by (rail, author) in arrival order,
// with a grace deadline so that delivery order and redelivery cannot false-alarm.
// It answers "is the classic channel still carrying group traffic", not "was
// this exact message filed".
//
// RUN AGAINST DynamoDB Local, deliberately. The whole mechanism IS DynamoDB key
// ranges and conditional writes - the per-IM dedupe marker, the deadline-prefixed
// due partition (A14: the messages table has NO GSI, so due-discovery is a Query
// over a sort-key range, never a scan), and the per-pair pending/credit ranges.
// An in-memory fake would only model my own assumptions back at me. Self-skipping
// like the other integration suites.
//
// The sweep is GLOBAL over one due partition, so every test mints its own rail
// and asserts on the alarms carrying that rail - no cross-test isolation needed,
// and the assertions stay true no matter what else is in flight.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { tableName } from '../src/lib/config.js';
import { createDocumentClient, createDynamoClient } from '../src/lib/dynamo.js';
import { deleteTableIfExists, ensureTable } from '../src/lib/dynamoAdmin.js';
import { getTableSpec } from '../src/lib/tables.js';
import { createGroupCrossCheck } from '../src/services/groupCrossCheck.js';
import { createMessagesRepo } from '../src/repos/messagesRepo.js';
import { GROUP_CROSSCHECK_LAST_EVENT_AT_ID } from '../src/repos/settingsRepo.js';

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
    `[groupCrossCheck.integration] SKIPPED - no DynamoDB Local at ${endpoint}. ` +
      'Run `npm run db:start` to exercise this suite.',
  );
}

const MEMBER = '+15551110001';
const OTHER_MEMBER = '+15559999999';
const BUSINESS = '+15550000000';
const ALARM = 'group_crosscheck_inbound_missing';
const T0 = '2026-08-11T12:00:00.000Z';
/** Comfortably past the grace deadline of anything recorded at T0. */
const AFTER_GRACE = '2026-08-11T13:00:00.000Z';

describe.skipIf(!reachable)('group cross-check against DynamoDB Local', () => {
  const testEnv = { TABLE_PREFIX: `hc-test-${randomUUID().slice(0, 8)}-` };
  const client = createDynamoClient({ endpoint });
  const doc = createDocumentClient({ endpoint });
  const table = tableName('messages', testEnv);

  beforeAll(async () => {
    await ensureTable(client, getTableSpec('messages'), table);
  }, 120_000);

  afterAll(async () => {
    await deleteTableIfExists(client, table);
    doc.destroy();
    client.destroy();
  }, 120_000);

  let seq = 0;
  function harness() {
    seq += 1;
    const rail = `CH${String(seq).padStart(10, '0')}${randomUUID().replace(/-/g, '')}`.slice(0, 34);
    const messages = createMessagesRepo({ doc, env: testEnv });
    const stamps: Array<{ id: string; at: string }> = [];
    const settings = {
      async putGroupTimestamp(id: string, at: string) {
        stamps.push({ id, at });
      },
      async getGroupTimestamp() {
        return undefined;
      },
    };
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    let clock = T0;
    const crossCheck = createGroupCrossCheck({
      messagesRepo: messages,
      settingsRepo: settings as never,
      businessNumber: BUSINESS,
      logger: log as never,
      now: () => new Date(clock),
    });
    let imSeq = 0;
    return {
      rail,
      crossCheck,
      log,
      stamps,
      setNow: (iso: string) => {
        clock = iso;
      },
      event: (over: Record<string, unknown> = {}) => ({
        messageSid: `IM${rail}${(imSeq += 1)}`,
        conversationSid: rail,
        participantSid: `MB${rail}`,
        author: MEMBER,
        source: 'SMS',
        dateCreated: clock,
        ...over,
      }),
      classic: (memberPhone = MEMBER) =>
        crossCheck.recordClassicInbound({
          conversationSid: rail,
          memberKey: `phone#${memberPhone}`,
          providerSid: `MM${(imSeq += 1)}`,
        }),
      /** Alarms raised for THIS test's rail. */
      sweep: async (nowIso = AFTER_GRACE) => {
        const outcome = await crossCheck.sweepCrossCheckDeadlines(nowIso);
        return outcome.alarms.filter((a) => a.conversationSid === rail);
      },
    };
  }

  describe('the input filter (spec 15.1)', () => {
    it('IGNORES an API-sourced event - our own posts must never alarm', async () => {
      const h = harness();
      await h.crossCheck.recordConversationEvent(h.event({ source: 'API' }));

      expect(await h.sweep()).toEqual([]);
      // Counted, not silently dropped.
      expect(h.log.info).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'group_crosscheck_event_ignored', reason: 'source' }),
        expect.any(String),
      );
    });

    it('IGNORES an event authored by our own business number', async () => {
      const h = harness();
      await h.crossCheck.recordConversationEvent(h.event({ author: BUSINESS }));

      expect(await h.sweep()).toEqual([]);
      expect(h.log.info).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'group_crosscheck_event_ignored', reason: 'author' }),
        expect.any(String),
      );
    });

    it('records the liveness high-water mark for a carrier-sourced event', async () => {
      const h = harness();
      await h.crossCheck.recordConversationEvent(h.event());
      expect(h.stamps).toEqual([{ id: GROUP_CROSSCHECK_LAST_EVENT_AT_ID, at: T0 }]);
      await h.sweep();
    });

    it('does NOT stamp liveness for an ignored API-sourced event', async () => {
      const h = harness();
      await h.crossCheck.recordConversationEvent(h.event({ source: 'API' }));
      expect(h.stamps).toEqual([]);
    });
  });

  describe('matching, in both delivery orders', () => {
    it('EVENT FIRST, then the classic filing: matched, nothing alarms', async () => {
      const h = harness();
      await h.crossCheck.recordConversationEvent(h.event());
      await h.classic();

      expect(await h.sweep()).toEqual([]);
    });

    it('CLASSIC FIRST, then the event: the credit matches it, nothing alarms', async () => {
      const h = harness();
      await h.classic();
      await h.crossCheck.recordConversationEvent(h.event());

      expect(await h.sweep()).toEqual([]);
    });

    it('a DUPLICATE redelivery of the same IM SID is deduped, not double-counted', async () => {
      const h = harness();
      const redelivered = h.event();
      await h.crossCheck.recordConversationEvent(redelivered);
      await h.crossCheck.recordConversationEvent(redelivered);

      // ONE classic filing clears the ONE real event.
      await h.classic();

      expect(await h.sweep()).toEqual([]);
      expect(h.log.info).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'group_crosscheck_event_duplicate' }),
        expect.any(String),
      );
    });

    it('RAPID SAME-AUTHOR messages match one-for-one, in order', async () => {
      const h = harness();
      await h.crossCheck.recordConversationEvent(h.event());
      h.setNow('2026-08-11T12:00:01.000Z');
      await h.crossCheck.recordConversationEvent(h.event());
      h.setNow('2026-08-11T12:00:02.000Z');
      const third = h.event();
      await h.crossCheck.recordConversationEvent(third);

      await h.classic();
      await h.classic();

      // Two of three matched; exactly one is still outstanding at the deadline,
      // and it is the OLDEST-unmatched accounting that leaves the newest behind.
      const alarms = await h.sweep();
      expect(alarms).toHaveLength(1);
      expect(alarms[0]!.messageSid).toBe(third.messageSid);
    });

    it('a filing for a DIFFERENT author does not clear this author event', async () => {
      const h = harness();
      await h.crossCheck.recordConversationEvent(h.event());
      await h.classic(OTHER_MEMBER);

      expect(await h.sweep()).toHaveLength(1);
    });
  });

  describe('the grace deadline and the alarm', () => {
    it('a GENUINE MISS alarms ONCE with the spec log line, then stops', async () => {
      const h = harness();
      await h.crossCheck.recordConversationEvent(h.event());

      expect(await h.sweep()).toHaveLength(1);
      expect(h.log.error).toHaveBeenCalledWith(
        expect.objectContaining({ event: ALARM, conversationSid: h.rail }),
        'conversation-bound inbound missing from classic webhook',
      );

      // Alarm ONCE: the row is resolved, so a later sweep is silent.
      h.log.error.mockClear();
      expect(await h.sweep('2026-08-11T14:00:00.000Z')).toEqual([]);
      expect(h.log.error).not.toHaveBeenCalled();
    });

    it('does NOT alarm before the grace deadline - delivery skew is not a failure', async () => {
      const h = harness();
      await h.crossCheck.recordConversationEvent(h.event());

      expect(await h.sweep('2026-08-11T12:00:01.000Z')).toEqual([]);
      expect(h.log.error).not.toHaveBeenCalled();
      await h.sweep(); // resolve it so it does not leak into a later sweep
    });

    it('a STALE credit does not mask a later genuine miss', async () => {
      const h = harness();
      // A classic filing banks a credit...
      await h.classic();
      // ...but the event only turns up an hour later, long past the match window.
      h.setNow('2026-08-11T13:00:00.000Z');
      await h.crossCheck.recordConversationEvent(h.event());

      expect(await h.sweep('2026-08-11T14:00:00.000Z')).toHaveLength(1);
    });
  });
});
