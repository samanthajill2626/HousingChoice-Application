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
import {
  buildGroupSendDueRow,
  buildTsMsgId,
  createMessagesRepo,
} from '../src/repos/messagesRepo.js';
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
      /**
       * File the CLASSIC half. `author` is the RAW webhook `From` - the service
       * normalizes it, which is what keeps the two halves' pair keys identical.
       * `providerSid` is fixed by a caller that wants to model a REDELIVERY.
       */
      classic: (author: string = MEMBER, providerSid?: string) =>
        crossCheck.recordClassicInbound({
          conversationSid: rail,
          author,
          // Rail-scoped like `event()`'s IM SIDs: the classic dedupe marker is
          // keyed by provider SID ALONE and the table is shared by the whole
          // file, so a bare counter would collide across tests.
          providerSid: providerSid ?? `MM${rail}${(imSeq += 1)}`,
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

  describe('the ledger dedupes BOTH sides (fix wave 4, X1/C1)', () => {
    // THE DEFECT THIS PINS. The classic half used to have no dedupe of its own,
    // and its credit's sort key carries a fresh `filedAt`, so a Twilio
    // REDELIVERY of the messaging webhook banked a SECOND credit for the (rail,
    // author) pair. Nothing consumes that phantom - until detection genuinely
    // breaks, at which point it absorbs an event whose classic filing NEVER
    // came, no pending row is written and NO ALARM EVER FIRES. That is exactly
    // the failure the whole mechanism exists to detect, so the phantom credit
    // silently blinds the only watch we have on `OtherRecipients{N}`.
    it('a REDELIVERED classic inbound banks NO second credit, so a later genuine miss still alarms', async () => {
      const h = harness();
      const redelivered = 'MMredelivered0001';

      // One carrier message: filed, then REDELIVERED by Twilio (same SM/MM SID).
      await h.classic(MEMBER, redelivered);
      await h.classic(MEMBER, redelivered);

      // The real event consumes the ONE legitimate credit.
      await h.crossCheck.recordConversationEvent(h.event());
      expect(await h.sweep()).toEqual([]);

      // Now detection breaks: an event arrives whose classic filing never came.
      // With a phantom credit banked it would be silently marked matched.
      h.setNow('2026-08-11T14:00:00.000Z');
      await h.crossCheck.recordConversationEvent(h.event());
      const alarms = await h.sweep('2026-08-11T15:00:00.000Z');
      expect(alarms).toHaveLength(1);

      expect(h.log.info).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'group_crosscheck_classic_duplicate',
          providerSid: redelivered,
        }),
        expect.any(String),
      );
    });

    it('a redelivered classic filing does not consume a SECOND pending event', async () => {
      const h = harness();
      const redelivered = 'MMredelivered0002';
      await h.crossCheck.recordConversationEvent(h.event());
      h.setNow('2026-08-11T12:00:01.000Z');
      await h.crossCheck.recordConversationEvent(h.event());

      // ONE classic message, delivered twice. It may clear exactly ONE event.
      await h.classic(MEMBER, redelivered);
      await h.classic(MEMBER, redelivered);

      expect(await h.sweep()).toHaveLength(1);
    });
  });

  describe('ONE pair-key builder for both halves (fix wave 4, X4)', () => {
    // THE DEFECT THIS PINS. The classic side keyed on the RAW webhook `From`
    // while the Conversations side keyed on a normalized author, so a single
    // non-canonical address made every event for that member miss its credit,
    // go pending, and alarm at the grace deadline - a storm of false
    // "envelope may have gone away" ERRORs on completely healthy traffic.
    it('a NON-CANONICAL classic From still matches the E.164 conversations author', async () => {
      const h = harness();
      await h.crossCheck.recordConversationEvent(h.event());
      // Same handset, formatted the way a human (or a replayed capture) writes it.
      await h.classic('(555) 111-0001');

      expect(await h.sweep()).toEqual([]);
    });

    it('a non-canonical classic filing FIRST is still found by the event', async () => {
      const h = harness();
      await h.classic('(555) 111-0001');
      await h.crossCheck.recordConversationEvent(h.event());

      expect(await h.sweep()).toEqual([]);
    });
  });

  describe('the ledger is a CLAIM, not check-then-act (fix wave 5, adversarial 3/9)', () => {
    // THE DEFECT THESE PIN. Both halves used to match by check-then-act: an
    // eventually-consistent Query for the other half's row, then an
    // UNCONDITIONAL delete whose result was never inspected. Two webhooks fired
    // by ONE carrier message could each miss the other - by a true interleave or
    // by read lag alone - so a `credit#` row AND an `evt#` row both survived for
    // the same message. Five minutes later the sweep logged
    // `group_crosscheck_inbound_missing` at ERROR (the channel that feeds the
    // production error-logs alarm) about a message the classic webhook filed
    // correctly, and the orphaned credit went on to absorb a LATER genuine miss,
    // silencing the only detector of `OtherRecipients{N}` disappearing.
    it('the exact t0-t4 interleave from the finding matches, and leaves NO orphan credit', async () => {
      const h = harness();
      // t0: both halves accepted. t1/t2: each "takes" before either "puts" -
      // which is the whole point: with one atomic balance there is no window
      // between taking and putting for the other half to fall into.
      await Promise.all([h.crossCheck.recordConversationEvent(h.event()), h.classic()]);

      // NO false alarm for the message the classic webhook filed correctly.
      expect(await h.sweep()).toEqual([]);
      expect(h.log.error).not.toHaveBeenCalled();

      // ...and NO orphaned credit left behind to mask the next real miss.
      h.setNow('2026-08-11T12:05:00.000Z');
      await h.crossCheck.recordConversationEvent(h.event());
      expect(await h.sweep('2026-08-11T12:30:00.000Z')).toHaveLength(1);
    });

    it('twenty concurrent event/classic pairs on one rail all match, with nothing left over', async () => {
      const h = harness();
      const pairs = 20;
      await Promise.all(
        Array.from({ length: pairs }, (_unused, i) =>
          i % 2 === 0
            ? Promise.all([h.crossCheck.recordConversationEvent(h.event()), h.classic()])
            : Promise.all([h.classic(), h.crossCheck.recordConversationEvent(h.event())]),
        ),
      );

      expect(await h.sweep()).toEqual([]);
      expect(h.log.error).not.toHaveBeenCalled();
    });

    it('two concurrent classic filings consume ONE pending event exactly once', async () => {
      // The old `takeCrossCheckPending` read Limit:1 and then deleted
      // unconditionally without checking the result, so two concurrent
      // consumers both returned "matched" for one row - and a genuinely
      // unfiled message was silently absorbed.
      const h = harness();
      await h.crossCheck.recordConversationEvent(h.event());

      // Two DISTINCT carrier messages (distinct provider SIDs - not a
      // redelivery), landing at the same instant.
      await Promise.all([h.classic(), h.classic()]);

      // One consumed the pending event; the OTHER banked a credit rather than
      // evaporating. So the next event matches, and nothing alarms.
      expect(await h.sweep()).toEqual([]);
      await h.crossCheck.recordConversationEvent(h.event());
      expect(await h.sweep()).toEqual([]);
    });

    it('an ALARMED event stops counting as pending, so a very late filing banks a credit instead', async () => {
      const h = harness();
      await h.crossCheck.recordConversationEvent(h.event());
      expect(await h.sweep()).toHaveLength(1); // given up on

      // The classic filing finally turns up an hour late. It must NOT "match"
      // the message we already reported missing - it is a fresh credit.
      h.setNow('2026-08-11T13:30:00.000Z');
      await h.classic();
      // Proof it banked: the NEXT event consumes it and nothing alarms.
      await h.crossCheck.recordConversationEvent(h.event());
      expect(await h.sweep('2026-08-11T14:30:00.000Z')).toEqual([]);
    });
  });

  describe('the two sweeps no longer share a deadline partition (fix wave 4, X3)', () => {
    // THE DEFECT THIS PINS. Both sweeps Queried ONE partition with `Limit: 50`
    // and dropped the other kind AFTER the limit was spent, so a full batch of
    // the other kind's rows starved this one completely - and the two failures
    // that produce those backlogs (a dead classic webhook, a dead receipts
    // webhook) are exactly the pair most likely to happen together.
    it('a BACKLOG of overdue SEND due rows cannot hide an unmatched event', async () => {
      const messages = createMessagesRepo({ doc, env: testEnv });
      const backlog = 50;
      await Promise.all(
        Array.from({ length: backlog }, (_unused, i) => {
          const providerSid = `IMstarveSend${String(i).padStart(4, '0')}`;
          const conversationId = `convGroup:starve-${i}`;
          const providerTs = new Date(Date.parse(T0) - (backlog - i) * 1000).toISOString();
          return messages.append({
            conversationId,
            providerSid,
            providerTs,
            type: 'sms',
            direction: 'outbound',
            author: 'teammate',
            body: 'starve',
            deliveryStatus: 'queued',
            deliveryRecipients: { 'phone#+15550000001': { status: 'queued' } },
            dueRow: buildGroupSendDueRow({
              conversationId,
              tsMsgId: buildTsMsgId(providerTs, providerSid),
              providerSid,
              deadlineAt: providerTs,
            }),
          });
        }),
      );

      const h = harness();
      await h.crossCheck.recordConversationEvent(h.event());

      expect(await h.sweep()).toHaveLength(1);
    });
  });
});
