// email-channel B4: the inbound-mail DISPATCH the worker's second SqsJobConsumer
// runs (and the dev route shares). It parses the SNS/SES envelope, then:
//   inbound  -> semaphore(2)-gated ingestInboundEmail (NEVER via dispatchJob)
//   event    -> the injectable applyEmailEvent seam (B5 wires; default log-and-ack)
//   ignored  -> ack (no side effects, no throw)
// A throwing ingest propagates so SQS redelivers / DLQs (never swallowed).
import { describe, expect, it, vi } from 'vitest';
import {
  createInboundMailDispatch,
  runSnsSesNotification,
  INBOUND_MAIL_INGEST_CONCURRENCY,
} from '../src/services/inboundMailConsumer.js';
import { createSemaphore } from '../src/lib/semaphore.js';
import type { InboundEmailNotice, IngestResult } from '../src/services/inboundEmail.js';
import type { SnsSesEvent, SnsSesNotification } from '../src/services/sesNotifications.js';

function inboundBody(over: Record<string, unknown> = {}): unknown {
  return {
    Type: 'Notification',
    Message: JSON.stringify({
      notificationType: 'Received',
      receipt: {
        action: { type: 'S3', bucketName: 'hc-inbound', objectKey: 'inbound/1.eml' },
        spamVerdict: { status: 'PASS' },
        virusVerdict: { status: 'PASS' },
        ...(over['receipt'] as object | undefined),
      },
      mail: { messageId: 'ses-recv-1' },
    }),
  };
}

function eventBody(): unknown {
  return {
    Type: 'Notification',
    Message: JSON.stringify({ eventType: 'Bounce', mail: { messageId: 'ses-out-1' }, bounce: { bounceType: 'Permanent' } }),
  };
}

const threaded: IngestResult = { outcome: 'threaded', conversationId: 'conv-1', tsMsgId: 'ts#1' };

describe('createInboundMailDispatch', () => {
  it('routes an inbound notification to ingest with the decoded bucket/key/verdicts', async () => {
    const ingest = vi.fn(async (_notice: InboundEmailNotice): Promise<IngestResult> => threaded);
    const dispatch = createInboundMailDispatch({ ingest });
    await dispatch(inboundBody());
    expect(ingest).toHaveBeenCalledTimes(1);
    expect(ingest.mock.calls[0]![0]).toEqual({
      bucket: 'hc-inbound',
      key: 'inbound/1.eml',
      spamVerdict: 'PASS',
      virusVerdict: 'PASS',
    });
  });

  it('routes an event notification to applyEmailEvent (NOT ingest) and never throws', async () => {
    const ingest = vi.fn(async (): Promise<IngestResult> => threaded);
    const applyEmailEvent = vi.fn(async (_event: SnsSesEvent) => {});
    const dispatch = createInboundMailDispatch({ ingest, applyEmailEvent });
    await expect(dispatch(eventBody())).resolves.toBeUndefined();
    expect(ingest).not.toHaveBeenCalled();
    expect(applyEmailEvent).toHaveBeenCalledTimes(1);
    expect(applyEmailEvent.mock.calls[0]![0]).toMatchObject({
      kind: 'event',
      eventType: 'Bounce',
      sesMessageId: 'ses-out-1',
      bounceType: 'Permanent',
    });
  });

  it('defaults applyEmailEvent to a no-throw log-and-ack (B5 unwired)', async () => {
    const ingest = vi.fn(async (): Promise<IngestResult> => threaded);
    const dispatch = createInboundMailDispatch({ ingest });
    await expect(dispatch(eventBody())).resolves.toBeUndefined();
    expect(ingest).not.toHaveBeenCalled();
  });

  it('acks an ignored/malformed notification (no ingest, no throw)', async () => {
    const ingest = vi.fn(async (): Promise<IngestResult> => threaded);
    const dispatch = createInboundMailDispatch({ ingest });
    await expect(dispatch({ Type: 'Notification', Message: 'not-json{' })).resolves.toBeUndefined();
    await expect(dispatch('garbage')).resolves.toBeUndefined();
    expect(ingest).not.toHaveBeenCalled();
  });

  it('propagates a throwing ingest so SQS redelivers (never poison-deletes)', async () => {
    const ingest = vi.fn(async (): Promise<IngestResult> => {
      throw new Error('inbound email raw object missing');
    });
    const dispatch = createInboundMailDispatch({ ingest });
    await expect(dispatch(inboundBody())).rejects.toThrow('raw object missing');
  });

  it('gates ingest concurrency at 2 (the transcode-semaphore mirror)', async () => {
    expect(INBOUND_MAIL_INGEST_CONCURRENCY).toBe(2);
    let active = 0;
    let maxActive = 0;
    const releases: Array<() => void> = [];
    const ingest = vi.fn(
      (_notice: InboundEmailNotice): Promise<IngestResult> =>
        new Promise<IngestResult>((resolve) => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          releases.push(() => {
            active -= 1;
            resolve(threaded);
          });
        }),
    );
    const dispatch = createInboundMailDispatch({ ingest });
    const p1 = dispatch(inboundBody());
    const p2 = dispatch(inboundBody());
    const p3 = dispatch(inboundBody());
    // Let the event loop settle: only 2 ingests may be in flight.
    await new Promise((r) => setTimeout(r, 10));
    expect(active).toBe(2);
    expect(maxActive).toBe(2);
    // Drain: release the first two, then the third can start.
    releases[0]!();
    releases[1]!();
    await new Promise((r) => setTimeout(r, 10));
    expect(active).toBe(1);
    releases[2]!();
    await Promise.all([p1, p2, p3]);
    expect(maxActive).toBe(2);
  });
});

describe('runSnsSesNotification', () => {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;

  it('returns { outcome:"unavailable" } for inbound when ingest is undefined', async () => {
    const parsed: SnsSesNotification = { kind: 'inbound', bucket: 'b', key: 'k' };
    const result = await runSnsSesNotification(parsed, {
      gate: createSemaphore(2),
      applyEmailEvent: async () => {},
      logger,
    });
    expect(result.outcome).toBe('unavailable');
  });

  it('surfaces the ingest outcome + ids for a threaded inbound', async () => {
    const parsed: SnsSesNotification = { kind: 'inbound', bucket: 'b', key: 'k', spamVerdict: 'FAIL' };
    const result = await runSnsSesNotification(parsed, {
      ingest: async (notice) => {
        expect(notice).toEqual({ bucket: 'b', key: 'k', spamVerdict: 'FAIL' });
        return { outcome: 'quarantined', unmatchedId: 'um-9' };
      },
      gate: createSemaphore(2),
      applyEmailEvent: async () => {},
      logger,
    });
    expect(result).toEqual({ outcome: 'quarantined', unmatchedId: 'um-9' });
  });
});
