// call.missedAutoText (M1.9b / CO2 §7.1 "Call triage at volume") — the zero-tap
// missed-call auto-text. When a founder-bridge call resolves to MISSED (no
// press-1 / no-answer / busy / failed), the /voice/status handler enqueues this
// job; the handler sends the founder-editable auto-text into the CALLER's 1:1
// conversation through the throttled, opt-out-gated send wrapper.
//
// IDEMPOTENCY — exactly ONE auto-text per missed call, EVER (the M1.9b
// guardrail). The execution marker is keyed by the CallSid (NOT the envelope
// jobId): a redelivered status callback can enqueue a SECOND job with a fresh
// jobId, and SQS can redeliver either — keying the marker on the stable CallSid
// makes the FIRST job to run win and every later one a no-op. (relayFanOut keys
// its marker on the envelope jobId because its dedupe target is the SQS
// redelivery of ONE enqueue; here the dedupe target is the missed call itself,
// which can be enqueued more than once — so CallSid is the correct key.)
//
// GATING: load OrgSettings; if missedCallAutoTextEnabled is false → mark done +
// skip (no send). Acquire ONE A2P token (shared bucket) before the send so the
// auto-text is paced under the registered tier alongside relay/broadcast. The
// send goes through sendMessage(automated:true), so the opt-out gate + the
// per-conversation breaker apply: a SendRefusedError (opt-out / breaker /
// manual mode) is a BY-DESIGN refusal — mark done + SKIP, never retry (retrying
// a STOP'd contact compounds the TCPA harm; retrying a tripped breaker fights
// the safety valve).
//
// PII (doc §9): NEVER the caller's phone/name or the body — callSid /
// conversationId / IDs only, correlated via the pino mixin.
import { logger as defaultLogger, type Logger } from '../lib/logger.js';
import type { TokenBucket } from '../lib/tokenBucket.js';
import { createSettingsRepo, type SettingsRepo } from '../repos/settingsRepo.js';
import {
  createSendMessageService,
  SendRefusedError,
  type SendMessageService,
} from '../services/sendMessage.js';
import { createMessagesRepo, type MessagesRepo } from '../repos/messagesRepo.js';
import { defineJobHandler } from './jobs.js';

export const MISSED_CALL_AUTOTEXT_JOB = 'call.missedAutoText';

export interface MissedCallAutoTextPayload {
  /** Twilio CallSid of the missed founder-bridge call — the idempotency key. */
  callSid: string;
  /** The caller's 1:1 conversation the auto-text is sent into. */
  conversationId: string;
}

export function parseMissedCallAutoTextPayload(payload: unknown): MissedCallAutoTextPayload {
  if (typeof payload !== 'object' || payload === null) {
    throw new Error('missedCallAutoText: payload is not an object');
  }
  const p = payload as Partial<MissedCallAutoTextPayload>;
  if (typeof p.callSid !== 'string' || p.callSid.length === 0) {
    throw new Error('missedCallAutoText: missing callSid');
  }
  if (typeof p.conversationId !== 'string' || p.conversationId.length === 0) {
    throw new Error('missedCallAutoText: missing conversationId');
  }
  return { callSid: p.callSid, conversationId: p.conversationId };
}

export interface MissedCallAutoTextJobDeps {
  settingsRepo?: SettingsRepo;
  sendMessageService?: SendMessageService;
  messagesRepo?: MessagesRepo;
  /** Shared A2P token bucket (worker boot). Optional — tests may omit pacing. */
  tokenBucket?: TokenBucket;
  logger?: Logger;
}

export function registerMissedCallAutoTextJobHandler(deps: MissedCallAutoTextJobDeps = {}): void {
  const log = deps.logger ?? defaultLogger;
  // Lazy: repos/services touch config + DynamoDB only on first job run.
  let settings = deps.settingsRepo;
  let sendMessage = deps.sendMessageService;
  let messages = deps.messagesRepo;

  defineJobHandler(MISSED_CALL_AUTOTEXT_JOB, async (rawPayload) => {
    const payload = parseMissedCallAutoTextPayload(rawPayload);
    settings ??= createSettingsRepo({ logger: deps.logger });
    sendMessage ??= createSendMessageService({ logger: deps.logger });
    messages ??= createMessagesRepo({ logger: deps.logger });

    // ONE auto-text per CallSid, EVER (the guardrail). Conditionally claim the
    // CallSid marker BEFORE any send: the first job to reach here wins, and a
    // redelivered status callback's second job — or an SQS redelivery of this
    // one — resolves as a no-op so the consumer deletes the message. The marker
    // partition (`job#<callSid>`) never collides with real conversation/sid
    // partitions (messagesRepo pointer-partition convention).
    const first = await messages.putJobExecutionMarker(payload.callSid, payload.conversationId);
    if (!first) {
      log.info(
        { callSid: payload.callSid, conversationId: payload.conversationId },
        'missed-call auto-text duplicate suppressed (CallSid already texted)',
      );
      return;
    }

    const orgSettings = await settings.getOrgSettings();
    if (!orgSettings.missedCallAutoTextEnabled) {
      // Marker already claimed above (so a redelivery stays a no-op) — the
      // toggle is OFF, so we deliberately send nothing.
      log.info(
        { callSid: payload.callSid, conversationId: payload.conversationId },
        'missed-call auto-text disabled in settings — skipped',
      );
      return;
    }

    // A2P meter: ONE token per real outbound SMS, acquired in the handler (the
    // correct per-message meter; the /voice/status producer does not throttle).
    await deps.tokenBucket?.acquire(1);

    try {
      await sendMessage({
        conversationId: payload.conversationId,
        body: orgSettings.missedCallAutoText,
        author: 'teammate',
        automated: true,
      });
    } catch (err) {
      if (err instanceof SendRefusedError) {
        // By-design refusal (opt-out / breaker / manual mode): SKIP, never
        // retry. The marker is already claimed, so no later job re-attempts.
        log.warn(
          { callSid: payload.callSid, conversationId: payload.conversationId, refusal: err.code },
          'missed-call auto-text refused (opt-out/breaker/manual) — skipped, not retried',
        );
        return;
      }
      // Unknown error: let the job FAIL so SQS redelivers — BUT the CallSid
      // marker is already claimed, so the redelivery is a no-op (we will NOT
      // double-text). This is deliberate: a transient provider error on a
      // best-effort courtesy text is not worth risking a duplicate; the founder
      // still got the missed-call push, and the caller can text in. Surface the
      // error so it is visible/alarmed.
      log.error(
        { err, callSid: payload.callSid, conversationId: payload.conversationId },
        'missed-call auto-text send failed (non-refusal) — not retried (marker claimed)',
      );
      throw err;
    }

    log.info(
      { callSid: payload.callSid, conversationId: payload.conversationId },
      'missed-call auto-text sent',
    );
  });
}
