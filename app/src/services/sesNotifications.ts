// email-channel B4: the SNS/SES envelope parser. ONE parser, ONE discriminated
// union, consumed by BOTH delivery mechanisms - the worker's inbound SQS
// consumer (prod: SES receipt rule -> S3 + SNS -> SQS) and the dev-gated webhook
// route (local/e2e: the fake-SES POST). Both hand us the SNS envelope already
// JSON-parsed (the SqsJobConsumer JSON.parses the SQS body; express.json parses
// the dev route body), but we defensively re-parse a string body too.
//
// Envelope shapes handled:
//   - SNS wrapper: { Type: 'Notification', Message: '<inner JSON string>' } -
//     the inner Message is itself a JSON string carrying the SES notification.
//   - SubscriptionConfirmation / UnsubscribeConfirmation -> 'ignored'. The
//     SubscribeURL is LOGGED at info WITHOUT being followed - the operator
//     confirms the subscription manually (see RUNBOOK Email (SES)). Auto-
//     confirming from app code would let anyone who can reach the route wire an
//     arbitrary SNS topic to our inbound path.
//   - Inner SES receipt notification: { notificationType: 'Received',
//     receipt: { action: { bucketName, objectKey }, spamVerdict, virusVerdict } }
//     -> { kind: 'inbound' }.
//   - Inner SES event notification: { eventType: 'Bounce'|'Complaint'|'Delivery',
//     mail: { messageId }, bounce: { bounceType } } -> { kind: 'event' }. The
//     classic { notificationType: 'Bounce'|... } shape is accepted too.
//   - Anything unrecognized / malformed -> { kind: 'ignored', reason }. This
//     function NEVER throws (a throw in the consumer dispatch would DLQ real
//     mail; a throw in the route would 5xx and drive an SNS retry loop).
//
// TRUST BOUNDARY (adv Q1 - stated explicitly): this parser does NO SNS
// signature verification, BY DESIGN. In PROD the SOLE authenticator is the SQS
// queue policy - it accepts messages only from the two SES mail topics
// (ArnEquals aws:SourceArn, infra/modules/inbound_mail/main.tf), so nothing
// unsigned can reach the worker's inbound consumer. LOCALLY / e2e the dev
// webhook route is gated by the x-origin-verify origin secret PLUS the triple
// prod-safety gate (config boot-throw on SES_API_BASE_URL in prod + conditional
// mount + request-time 404); the parser even accepts a direct/unwrapped SES
// shape for that dev path. If the queue policy were ever loosened off the topic
// SourceArn, spoofed unsigned notifications would be trusted - so that policy
// is load-bearing and must stay SourceArn-scoped.
//
// PII (plan F18): addresses/subjects/bodies never appear in logs; only the
// bucket/key/ids/verdicts/subscribe-URL do (none are message content).
import { logger as defaultLogger, type Logger } from '../lib/logger.js';

/** Spam verdict statuses we act on; others (PROCESSING_FAILED/DISABLED) omit. */
export type SpamVerdict = 'PASS' | 'FAIL' | 'GRAY';
/** Virus verdict statuses we act on; others omit. */
export type VirusVerdict = 'PASS' | 'FAIL';
/** SES event types the pipeline reacts to (B5 applies bounce/complaint/delivery). */
export type SesEventType = 'Bounce' | 'Complaint' | 'Delivery';

export type SnsSesNotification =
  | {
      kind: 'inbound';
      bucket: string;
      key: string;
      spamVerdict?: SpamVerdict;
      virusVerdict?: VirusVerdict;
    }
  | {
      kind: 'event';
      eventType: SesEventType;
      sesMessageId: string;
      bounceType?: string;
      /** The full inner SES notification (B5 reads recipients/diagnostics). */
      payload: Record<string, unknown>;
    }
  | { kind: 'ignored'; reason: string };

/** The event variant, extracted for the B5 `applyEmailEvent` seam signature. */
export type SnsSesEvent = Extract<SnsSesNotification, { kind: 'event' }>;
/** The inbound variant, extracted for the delivery-mechanism dispatch. */
export type SnsSesInbound = Extract<SnsSesNotification, { kind: 'inbound' }>;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Coerce a body that may be a JSON string OR an already-parsed object. */
function coerceObject(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === 'string') {
    try {
      return asRecord(JSON.parse(value));
    } catch {
      return undefined;
    }
  }
  return asRecord(value);
}

function mapSpamVerdict(verdict: unknown): SpamVerdict | undefined {
  const status = asRecord(verdict)?.['status'];
  return status === 'PASS' || status === 'FAIL' || status === 'GRAY' ? status : undefined;
}

function mapVirusVerdict(verdict: unknown): VirusVerdict | undefined {
  const status = asRecord(verdict)?.['status'];
  return status === 'PASS' || status === 'FAIL' ? status : undefined;
}

function isEventType(value: unknown): value is SesEventType {
  return value === 'Bounce' || value === 'Complaint' || value === 'Delivery';
}

/**
 * Parse an SNS/SES notification into the discriminated union above. NEVER
 * throws - malformed input is always { kind: 'ignored' }.
 */
export function parseSnsSesNotification(body: unknown, logger: Logger = defaultLogger): SnsSesNotification {
  try {
    const outer = coerceObject(body);
    if (outer === undefined) return { kind: 'ignored', reason: 'body is not an object' };

    // ---- SNS control messages -------------------------------------------------
    const snsType = outer['Type'];
    if (snsType === 'SubscriptionConfirmation') {
      const subscribeUrl = typeof outer['SubscribeURL'] === 'string' ? outer['SubscribeURL'] : undefined;
      // Log for the operator; DO NOT fetch it (manual confirmation only).
      logger.info(
        { subscribeUrl, topicArn: outer['TopicArn'] },
        'SES/SNS SubscriptionConfirmation received - confirm manually via the SubscribeURL (never auto-followed)',
      );
      return { kind: 'ignored', reason: 'subscription_confirmation' };
    }
    if (snsType === 'UnsubscribeConfirmation') {
      return { kind: 'ignored', reason: 'unsubscribe_confirmation' };
    }

    // ---- Unwrap the inner SES notification -----------------------------------
    // Type 'Notification' -> the SES payload is the JSON string in `Message`.
    // Otherwise, defensively accept a DIRECT (raw-delivery / unwrapped) SES
    // notification when the object itself already looks like one.
    let inner: Record<string, unknown> | undefined;
    if (snsType === 'Notification') {
      inner = coerceObject(outer['Message']);
      if (inner === undefined) return { kind: 'ignored', reason: 'SNS Message is not parseable JSON' };
    } else if (outer['notificationType'] !== undefined || outer['eventType'] !== undefined) {
      inner = outer;
    } else {
      return { kind: 'ignored', reason: 'unrecognized envelope (no SNS Type / SES notification)' };
    }

    const notificationType = inner['notificationType'];
    const eventType = inner['eventType'];

    // ---- Inbound receipt ------------------------------------------------------
    if (notificationType === 'Received') {
      const receipt = asRecord(inner['receipt']);
      const action = asRecord(receipt?.['action']);
      const bucket = action?.['bucketName'];
      const key = action?.['objectKey'];
      if (typeof bucket !== 'string' || bucket.length === 0 || typeof key !== 'string' || key.length === 0) {
        return { kind: 'ignored', reason: 'Received notification missing S3 action bucket/key' };
      }
      const spamVerdict = mapSpamVerdict(receipt?.['spamVerdict']);
      const virusVerdict = mapVirusVerdict(receipt?.['virusVerdict']);
      return {
        kind: 'inbound',
        bucket,
        key,
        ...(spamVerdict !== undefined && { spamVerdict }),
        ...(virusVerdict !== undefined && { virusVerdict }),
      };
    }

    // ---- Event notification (config-set eventType OR classic notificationType) -
    const resolvedEventType = isEventType(eventType)
      ? eventType
      : isEventType(notificationType)
        ? notificationType
        : undefined;
    if (resolvedEventType !== undefined) {
      const mail = asRecord(inner['mail']);
      const sesMessageId = mail?.['messageId'];
      if (typeof sesMessageId !== 'string' || sesMessageId.length === 0) {
        return { kind: 'ignored', reason: 'event notification missing mail.messageId' };
      }
      const bounceType = resolvedEventType === 'Bounce' ? asRecord(inner['bounce'])?.['bounceType'] : undefined;
      return {
        kind: 'event',
        eventType: resolvedEventType,
        sesMessageId,
        ...(typeof bounceType === 'string' && bounceType.length > 0 && { bounceType }),
        payload: inner,
      };
    }

    return {
      kind: 'ignored',
      reason: `unrecognized notification (notificationType=${String(notificationType)}, eventType=${String(eventType)})`,
    };
  } catch (err) {
    // Belt-and-braces: the guards above should make this unreachable, but the
    // NEVER-throws contract is load-bearing (a throw DLQs mail / 5xx-retries).
    logger.error({ err }, 'parseSnsSesNotification unexpected error - ignoring');
    return { kind: 'ignored', reason: 'exception during parse' };
  }
}
