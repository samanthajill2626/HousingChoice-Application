// updateCallStatus at the WIRE level (fix wave 4, findings N-1 + N-3).
//
// WHY A WIRE-LEVEL SUITE. Every voice-webhook test drives the harness FAKE
// (docs/issues/update-call-status-fake-mirrors-real-so-a-broken-repo-is-invisible.md),
// so the REAL repo's two behaviours this wave depends on are otherwise
// unasserted: that it HANDS BACK the row it already resolved (so the gate
// announce needs no second, eventually-consistent read on the bridge-connect
// path), and that an impossible CALLER EXPECTATION is distinguishable from the
// "nothing transitions into ringing" case instead of sharing its silent return.
// These assert the commands the repo issues and what it returns, against a doc
// client that records every send.
import { describe, expect, it } from 'vitest';
import { createLogger } from '../src/lib/logger.js';
import { createMessagesRepo, type MessageItem, type MessagesRepo } from '../src/repos/messagesRepo.js';
import { createLogCapture, type LogCapture } from './helpers/logCapture.js';

const CALL_SID = 'CAwire0000000000000000000000000001';
/** Never appears in a log line - the PII guard below proves it. */
const PARTY_PHONE = '+15550100077';

function storedCall(over: Partial<MessageItem> = {}): MessageItem {
  return {
    conversationId: 'conv-wire-1',
    tsMsgId: `2026-08-19T10:00:00.000Z#${CALL_SID}`,
    type: 'call',
    direction: 'outbound',
    author: 'teammate',
    provider_sid: CALL_SID,
    provider_ts: '2026-08-19T10:00:00.000Z',
    delivery_status: 'sent',
    created_at: '2026-08-19T10:00:00.000Z',
    call_status: 'ringing',
    masked: false,
    // A stored phone on the row, so "the warn names IDs only" is a real claim.
    participant_phone: PARTY_PHONE,
    ...over,
  };
}

interface Sent {
  name: string;
  input: Record<string, unknown>;
}

/**
 * A doc client that answers the sid-pointer get and the item get from ONE
 * modelled row (undefined = an unknown CallSid) and records every command, so a
 * test can assert both the returned value and the round trips it cost.
 */
function repoWith(row: MessageItem | undefined): {
  repo: MessagesRepo;
  sent: Sent[];
  capture: LogCapture;
} {
  const sent: Sent[] = [];
  const capture = createLogCapture();
  const doc = {
    async send(cmd: unknown): Promise<unknown> {
      const command = cmd as { constructor: { name: string }; input: Record<string, unknown> };
      sent.push({ name: command.constructor.name, input: command.input });
      if (command.constructor.name !== 'GetCommand') return {};
      const key = command.input['Key'] as { tsMsgId: string };
      if (key.tsMsgId === 'ptr') {
        return row === undefined
          ? {}
          : { Item: { ref_conversationId: row.conversationId, ref_tsMsgId: row.tsMsgId } };
      }
      return { Item: row };
    },
  };
  const repo = createMessagesRepo({
    doc: doc as never,
    env: { TABLE_PREFIX: 'hc-unit-' },
    logger: createLogger({ destination: capture.stream }),
  });
  return { repo, sent, capture };
}

describe('updateCallStatus returns the row it already resolved (N-1)', () => {
  it('a committed transition hands back the row, and costs exactly two gets + one write', async () => {
    const row = storedCall();
    const { repo, sent } = repoWith(row);

    const result = await repo.updateCallStatus(CALL_SID, {
      callStatus: 'in-progress',
      answeredAt: '2026-08-19T10:00:05.000Z',
    });

    expect(result.transitioned).toBe(true);
    // THE POINT OF THE WHOLE FIX: the caller now has the row, so the press-1
    // announce between the keypress and the <Dial> performs NO read of its own.
    expect(result.row?.conversationId).toBe(row.conversationId);
    expect(result.row?.tsMsgId).toBe(row.tsMsgId);
    expect(result.row?.direction).toBe('outbound');
    expect(result.row?.delivery_status).toBe('sent');
    expect(sent.map((s) => s.name)).toEqual(['GetCommand', 'GetCommand', 'UpdateCommand']);
  });

  it('an unknown CallSid returns no row and never writes', async () => {
    const { repo, sent } = repoWith(undefined);

    const result = await repo.updateCallStatus(CALL_SID, { callStatus: 'in-progress' });

    expect(result.transitioned).toBe(false);
    expect(result.row).toBeUndefined();
    expect(sent.some((s) => s.name === 'UpdateCommand')).toBe(false);
  });

  it('a refused transition still hands back the row (the caller may need its ids)', async () => {
    // `ringing` is unreachable from `completed` in the forward-only machine, so
    // the intersection is non-empty but the write is refused by DynamoDB. The
    // row is the one the repo resolved either way.
    const row = storedCall({ call_status: 'completed' });
    const { repo } = repoWith(row);

    const result = await repo.updateCallStatus(
      CALL_SID,
      { callStatus: 'canceled' },
      { expectedPriorCallStatuses: ['ringing'] },
    );

    // The modelled doc client never throws, so this asserts the shape only:
    // a row is always returned once the CallSid resolved.
    expect(result.row?.tsMsgId).toBe(row.tsMsgId);
  });
});

describe('an impossible caller expectation is its own branch, and it WARNs (N-3)', () => {
  it('an expectation that cannot intersect the allowed set warns with both sets and writes nothing', async () => {
    const { repo, sent, capture } = repoWith(storedCall());

    // `canceled` may follow ringing/in-progress; a caller expecting `completed`
    // can never satisfy that, so no prior status exists for which this write
    // could commit. That is a CALLER bug, not the ringing case.
    const result = await repo.updateCallStatus(
      CALL_SID,
      { callStatus: 'canceled' },
      { expectedPriorCallStatuses: ['completed'] },
    );

    expect(result.transitioned).toBe(false);
    expect(sent.some((s) => s.name === 'UpdateCommand')).toBe(false);
    const warns = capture.atLevel(40);
    expect(warns).toHaveLength(1);
    const warn = warns[0]!;
    expect(warn['callSid']).toBe(CALL_SID);
    expect(warn['expectedPriorCallStatuses']).toEqual(['completed']);
    expect(warn['allowedPriorCallStatuses']).toEqual(['ringing', 'in-progress']);
    // PII (doc 9): IDs + status values only, never a phone.
    expect(JSON.stringify(warns)).not.toContain(PARTY_PHONE);
  });

  it('nothing transitions INTO ringing - that stays a silent, expected no-op', async () => {
    const { repo, sent, capture } = repoWith(storedCall());

    const result = await repo.updateCallStatus(CALL_SID, { callStatus: 'ringing' });

    expect(result.transitioned).toBe(false);
    expect(sent.some((s) => s.name === 'UpdateCommand')).toBe(false);
    // Not a caller bug and not an anomaly: no warn, or the log fills with noise
    // from a perfectly ordinary redelivery.
    expect(capture.atLevel(40)).toHaveLength(0);
  });
});
