import { test, expect } from '@playwright/test';
import {
  registerParty,
  sendGroupAsParty,
  listConversations,
  injectConversationEvent,
} from '../../fixtures/fakeTwilio.js';
import { clearLogTail, minutesFromNow, readLogTail, tickGuardrails } from '../../fixtures/groupText.js';
import { conversationIdForGroup } from '../../../app/src/lib/import/ids.js';

// SPEC 6 - guardrail 2: the cross-check that notices the envelope going away.
//
// Detection depends on an UNDOCUMENTED form param. If Twilio removes it, group
// inbound stops being recognized and starts filing as 1:1 - silently, and
// looking completely normal. The cross-check is the second pair of eyes: every
// carrier-sourced message that reaches the Conversation is matched against a
// classic filing, and an unmatched one alarms at its grace deadline.
//
// Three states, and only the middle one is a real alarm:
//   MATCHED   - both channels saw it. Quiet.
//   MISSED    - the Conversation saw it, the classic webhook did not. ERROR.
//   API-SOURCE- our own post echoing back. Ignored, by the Source filter.
//
// A16: the sweep runs in the WORKER too, and the worker's log lines never reach
// the app's `/__dev/logtail`. Every assertion here drives the APP-side tick, and
// passes an explicit `now` PAST the grace deadline so nothing waits on a clock.
const GRACE_STEP_MINUTES = 15;

test.describe('the group cross-check', () => {
  test('a matched inbound stays quiet; an unmatched one ERRORs; an API-sourced one is ignored', async ({
    request,
  }) => {
    test.slow();
    const stamp = `${Date.now()}`.slice(-6);
    const ANA = `+1555088${stamp.slice(-4)}`;
    const BEN = `+1555089${stamp.slice(-4)}`;
    const conversationId = conversationIdForGroup([ANA, BEN]);

    await registerParty(request, { label: `Ana xc ${stamp}`, role: 'tenant', number: ANA });
    await sendGroupAsParty(request, {
      from: ANA,
      otherRecipients: [BEN],
      body: `opening for the cross-check ${stamp}`,
    });

    // The cross-check only sees RAILED threads - an unrailed group produces no
    // Conversations event at all. That is the honest coverage gap the design
    // states, and it is why this waits for the rail before proving anything.
    await expect
      .poll(
        async () => (await listConversations(request)).some((c) => c.uniqueName === conversationId),
        { timeout: 25_000, message: 'the group rail was never created' },
      )
      .toBe(true);
    const railSid = (await listConversations(request)).find((c) => c.uniqueName === conversationId)!
      .sid;

    // THE FAKE HAVING THE RAIL IS NOT THE APP HAVING IT. The adapter creates the
    // Conversation, reads its participants back, and only then does the service
    // persist the sid on the thread - and it is the PERSISTED sid the classic
    // filing checks before recording its half of the match. An inbound landing
    // in that window files normally but records nothing, so its Conversations
    // event would sit unmatched and alarm: a HEALTHY channel looking exactly
    // like the failure this guardrail exists to detect.
    //
    // `group_railed_inbound_last_at` is written by the same `hasActiveGroupRail`
    // branch as the cross-check's classic half, so watching it CHANGE is a
    // direct observation of that gate opening. It is a global high-water mark,
    // hence "changed from what it was", not "is set".
    const railedAtBefore = String(
      (
        (await tickGuardrails(request, { duties: ['channel_quiet'] })).results['channel_quiet'] as {
          railedAt?: string;
        }
      ).railedAt ?? '',
    );
    await expect
      .poll(
        async () => {
          await sendGroupAsParty(request, {
            from: ANA,
            otherRecipients: [BEN],
            body: `warming the rail ${Date.now()}`,
          });
          const tickResult = await tickGuardrails(request, { duties: ['channel_quiet'] });
          return String(
            (tickResult.results['channel_quiet'] as { railedAt?: string }).railedAt ?? '',
          );
        },
        { timeout: 30_000, message: 'the app never persisted the rail onto the thread' },
      )
      .not.toBe(railedAtBefore);

    // Flush anything the pre-railed window left pending, so the clean window
    // below starts genuinely clean rather than inheriting a warm-up's event.
    await tickGuardrails(request, {
      now: minutesFromNow(GRACE_STEP_MINUTES),
      duties: ['crosscheck_sweep'],
    });
    await clearLogTail(request);

    // --- 1) MATCHED: both channels see the same message -------------------
    // The fake fires the classic webhook AND the carrier-sourced
    // `onMessageAdded`, which is what a healthy production inbound does.
    await sendGroupAsParty(request, {
      from: ANA,
      otherRecipients: [BEN],
      body: `matched inbound ${stamp}`,
    });

    let tick = await tickGuardrails(request, {
      now: minutesFromNow(GRACE_STEP_MINUTES),
      duties: ['crosscheck_sweep'],
    });
    expect(tick.ran).toContain('crosscheck_sweep');
    let alarms = await readLogTail(request, { event: 'group_crosscheck_inbound_missing' });
    expect(
      alarms.filter((l) => l['conversationSid'] === railSid),
      'a matched inbound must not alarm - both channels saw it',
    ).toHaveLength(0);

    // --- 2) API-SOURCED: our own post echoing back ------------------------
    // Filtered out by Source. Asserted BEFORE the miss so a passing miss can
    // never be what makes this look right.
    await injectConversationEvent(request, {
      conversationSid: railSid,
      author: ANA,
      body: `api echo ${stamp}`,
      source: 'API',
    });
    tick = await tickGuardrails(request, {
      now: minutesFromNow(GRACE_STEP_MINUTES),
      duties: ['crosscheck_sweep'],
    });
    alarms = await readLogTail(request, { event: 'group_crosscheck_inbound_missing' });
    expect(
      alarms.filter((l) => l['conversationSid'] === railSid),
      'an API-sourced event is our own post - counting it would alarm on every outbound',
    ).toHaveLength(0);

    // --- 3) MISSED: the Conversation saw it, the classic webhook did not ---
    // This is the shape a withdrawn `OtherRecipients` contract produces, and
    // the only way to manufacture it is to fire the Conversations event alone.
    const missed = await injectConversationEvent(request, {
      conversationSid: railSid,
      author: BEN,
      body: `never reached the classic webhook ${stamp}`,
      source: 'SMS',
    });

    tick = await tickGuardrails(request, {
      now: minutesFromNow(GRACE_STEP_MINUTES),
      duties: ['crosscheck_sweep'],
    });
    expect((tick.results['crosscheck_sweep'] as { alarmed?: number }).alarmed ?? 0).toBeGreaterThan(0);

    await expect
      .poll(
        async () => {
          const lines = await readLogTail(request, { event: 'group_crosscheck_inbound_missing' });
          return lines.filter((l) => l['messageSid'] === missed.messageSid).length;
        },
        { timeout: 10_000, message: 'the unmatched conversation event never alarmed' },
      )
      .toBe(1);

    const [alarm] = (await readLogTail(request, { event: 'group_crosscheck_inbound_missing' })).filter(
      (l) => l['messageSid'] === missed.messageSid,
    );
    expect(alarm?.level).toBe(50); // ERROR - this one is a real incident
    expect(alarm?.['conversationSid']).toBe(railSid);
    // Ids only. The alarm names the rail so it can be found; it must never
    // carry the handsets that were on it.
    expect(JSON.stringify(alarm)).not.toContain(BEN);

    // 4) It fires EXACTLY ONCE. The pending row is resolved as the alarm is
    //    emitted, so a five-minute sweep cannot turn one outage into a pager
    //    loop.
    await tickGuardrails(request, {
      now: minutesFromNow(GRACE_STEP_MINUTES + 5),
      duties: ['crosscheck_sweep'],
    });
    const repeated = (await readLogTail(request, { event: 'group_crosscheck_inbound_missing' })).filter(
      (l) => l['messageSid'] === missed.messageSid,
    );
    expect(repeated).toHaveLength(1);
  });
});
