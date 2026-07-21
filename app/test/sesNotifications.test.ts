// email-channel B4: the SNS/SES envelope parser (services/sesNotifications.ts) -
// ONE discriminated-union parser consumed by BOTH the worker inbound consumer
// and the dev-gated webhook route. It must NEVER throw (malformed input maps to
// { kind: 'ignored' }), and it must not follow the SubscriptionConfirmation URL.
import { describe, expect, it, vi } from 'vitest';
import { parseSnsSesNotification } from '../src/services/sesNotifications.js';
import type { Logger } from '../src/lib/logger.js';

/** A minimal SNS envelope wrapping an inner SES notification JSON string. */
function snsEnvelope(inner: unknown, over: Record<string, unknown> = {}): unknown {
  return {
    Type: 'Notification',
    MessageId: 'sns-msg-1',
    TopicArn: 'arn:aws:sns:us-east-1:000000000000:hc-dev-mail-inbound',
    Message: JSON.stringify(inner),
    Timestamp: '2026-07-20T00:00:00.000Z',
    ...over,
  };
}

const receivedInner = (over: Record<string, unknown> = {}) => ({
  notificationType: 'Received',
  receipt: {
    timestamp: '2026-07-20T00:00:00.000Z',
    action: { type: 'S3', bucketName: 'hc-inbound-mail', objectKey: 'inbound/abc.eml' },
    spamVerdict: { status: 'PASS' },
    virusVerdict: { status: 'PASS' },
    ...(over['receipt'] as object | undefined),
  },
  mail: { messageId: 'ses-recv-1', source: 'sender@example.com' },
  ...over,
});

function fakeLogger(): { logger: Logger; info: ReturnType<typeof vi.fn> } {
  const info = vi.fn();
  const logger = { info, warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
  return { logger, info };
}

describe('parseSnsSesNotification - inbound receipt', () => {
  it('unwraps an SNS Notification -> Received receipt into an inbound result', () => {
    const parsed = parseSnsSesNotification(snsEnvelope(receivedInner()));
    expect(parsed).toEqual({
      kind: 'inbound',
      bucket: 'hc-inbound-mail',
      key: 'inbound/abc.eml',
      spamVerdict: 'PASS',
      virusVerdict: 'PASS',
    });
  });

  it('maps spam GRAY / virus FAIL verdicts through', () => {
    const parsed = parseSnsSesNotification(
      snsEnvelope(
        receivedInner({
          receipt: {
            action: { type: 'S3', bucketName: 'b', objectKey: 'k' },
            spamVerdict: { status: 'GRAY' },
            virusVerdict: { status: 'FAIL' },
          },
        }),
      ),
    );
    expect(parsed).toEqual({ kind: 'inbound', bucket: 'b', key: 'k', spamVerdict: 'GRAY', virusVerdict: 'FAIL' });
  });

  it('omits verdicts whose status is unrecognized (PROCESSING_FAILED / DISABLED)', () => {
    const parsed = parseSnsSesNotification(
      snsEnvelope(
        receivedInner({
          receipt: {
            action: { type: 'S3', bucketName: 'b', objectKey: 'k' },
            spamVerdict: { status: 'PROCESSING_FAILED' },
            virusVerdict: { status: 'DISABLED' },
          },
        }),
      ),
    );
    expect(parsed).toEqual({ kind: 'inbound', bucket: 'b', key: 'k' });
  });

  it('ignores a Received notification whose receipt has no S3 action target', () => {
    const parsed = parseSnsSesNotification(
      snsEnvelope(
        receivedInner({ receipt: { action: { type: 'Lambda' }, spamVerdict: { status: 'PASS' } } }),
      ),
    );
    expect(parsed.kind).toBe('ignored');
  });

  it('accepts a DIRECT (raw-delivery / unwrapped) Received notification', () => {
    const parsed = parseSnsSesNotification(receivedInner());
    expect(parsed).toMatchObject({ kind: 'inbound', bucket: 'hc-inbound-mail', key: 'inbound/abc.eml' });
  });
});

describe('parseSnsSesNotification - event notifications', () => {
  it('parses a Bounce (eventType) with bounceType + sesMessageId + payload', () => {
    const inner = {
      eventType: 'Bounce',
      mail: { messageId: 'ses-out-9' },
      bounce: { bounceType: 'Permanent', bouncedRecipients: [{ emailAddress: 'x@y.z' }] },
    };
    const parsed = parseSnsSesNotification(snsEnvelope(inner));
    expect(parsed).toMatchObject({
      kind: 'event',
      eventType: 'Bounce',
      sesMessageId: 'ses-out-9',
      bounceType: 'Permanent',
    });
    if (parsed.kind === 'event') expect(parsed.payload).toEqual(inner);
  });

  it('parses a Complaint (no bounceType)', () => {
    const parsed = parseSnsSesNotification(
      snsEnvelope({ eventType: 'Complaint', mail: { messageId: 'ses-out-10' }, complaint: {} }),
    );
    expect(parsed).toMatchObject({ kind: 'event', eventType: 'Complaint', sesMessageId: 'ses-out-10' });
    if (parsed.kind === 'event') expect(parsed.bounceType).toBeUndefined();
  });

  it('parses a Delivery event', () => {
    const parsed = parseSnsSesNotification(
      snsEnvelope({ eventType: 'Delivery', mail: { messageId: 'ses-out-11' }, delivery: {} }),
    );
    expect(parsed).toMatchObject({ kind: 'event', eventType: 'Delivery', sesMessageId: 'ses-out-11' });
  });

  it('accepts the classic notificationType Bounce shape (defensive)', () => {
    const parsed = parseSnsSesNotification(
      snsEnvelope({ notificationType: 'Bounce', mail: { messageId: 'ses-out-12' }, bounce: { bounceType: 'Transient' } }),
    );
    expect(parsed).toMatchObject({ kind: 'event', eventType: 'Bounce', sesMessageId: 'ses-out-12', bounceType: 'Transient' });
  });

  it('ignores an event missing mail.messageId', () => {
    const parsed = parseSnsSesNotification(snsEnvelope({ eventType: 'Delivery', delivery: {} }));
    expect(parsed.kind).toBe('ignored');
  });
});

describe('parseSnsSesNotification - control + malformed (never throws)', () => {
  it('ignores SubscriptionConfirmation and logs the SubscribeURL WITHOUT following it', () => {
    const { logger, info } = fakeLogger();
    const parsed = parseSnsSesNotification(
      { Type: 'SubscriptionConfirmation', SubscribeURL: 'https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription&Token=xyz' },
      logger,
    );
    expect(parsed.kind).toBe('ignored');
    // The URL is logged for the operator; it is NEVER fetched by the parser.
    expect(info).toHaveBeenCalled();
    const logged = JSON.stringify(info.mock.calls);
    expect(logged).toContain('ConfirmSubscription');
  });

  it('ignores UnsubscribeConfirmation', () => {
    expect(parseSnsSesNotification({ Type: 'UnsubscribeConfirmation' }).kind).toBe('ignored');
  });

  it('ignores non-object / null / number bodies without throwing', () => {
    expect(parseSnsSesNotification(null).kind).toBe('ignored');
    expect(parseSnsSesNotification(42).kind).toBe('ignored');
    expect(parseSnsSesNotification('nonsense').kind).toBe('ignored');
  });

  it('parses a stringified SNS envelope body', () => {
    const parsed = parseSnsSesNotification(JSON.stringify(snsEnvelope(receivedInner())));
    expect(parsed).toMatchObject({ kind: 'inbound', bucket: 'hc-inbound-mail' });
  });

  it('ignores a Notification whose inner Message is not JSON', () => {
    expect(parseSnsSesNotification({ Type: 'Notification', Message: 'not-json{' }).kind).toBe('ignored');
  });

  it('ignores an unrecognized notification shape', () => {
    expect(parseSnsSesNotification(snsEnvelope({ notificationType: 'AmazonSnsSubscriptionSucceeded' })).kind).toBe('ignored');
  });
});
