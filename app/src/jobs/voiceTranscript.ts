// voice.createTranscript + voice.reconcileTranscript (voice-transcription spec
// 3.2 / 3.4) - the RELIABILITY half of the VI pipeline. The recording handler
// creates the transcript INLINE on the happy path (fast); these jobs are the
// fallback + self-heal:
//   - createVoiceTranscript: the fallback the recording handler enqueues when
//     the inline VI create fails (Twilio error/timeout). Re-attempts the create
//     via the standard jobs pipeline (SQS redelivery -> DLQ on repeated failure).
//   - reconcileVoiceTranscript: the webhook-loss self-heal. Enqueued ~10min after
//     a successful create; re-checks the VI transcript and persists it if the
//     completion webhook never arrived, re-enqueueing up to RECONCILE_MAX_ATTEMPTS
//     before stamping the transcript failed.
//
// Both REUSE persistViTranscript (the same helper the webhook uses) so the two
// return legs can never drift - whichever runs first wins on never-overwrite.
//
// PII (doc section 9): NEVER the transcript/sentence text - callSid / recordingSid
// / transcriptSid / lengths only.
import { logger as defaultLogger, type Logger } from '../lib/logger.js';
import { loadConfig, type AppConfig } from '../lib/config.js';
import { createMessagingAdapter, type MessagingAdapter } from '../adapters/messaging.js';
import { createMessagesRepo, type MessagesRepo } from '../repos/messagesRepo.js';
import { appEvents, type EventBus } from '../lib/events.js';
import { persistViTranscript } from '../services/voiceTranscripts.js';
import { defineJobHandler, enqueue } from './jobs.js';

export const CREATE_VOICE_TRANSCRIPT_JOB = 'voice.createTranscript';
export const RECONCILE_VOICE_TRANSCRIPT_JOB = 'voice.reconcileTranscript';

/** Reconcile re-checks the VI transcript this many times before stamping failed. */
export const RECONCILE_MAX_ATTEMPTS = 3;

/** The fallback create retries this many times before stamping failed (planner
 * review finding 1: without a cap-and-stamp, a sustained VI outage left
 * transcript_status 'pending' forever - "Transcribing..." with no self-heal). */
export const CREATE_MAX_ATTEMPTS = 3;

export interface CreateVoiceTranscriptPayload {
  /** Twilio CallSid of the founder-bridge call = the VI CustomerKey. */
  callSid: string;
  /** RecordingSid of the mirrored recording to transcribe. */
  recordingSid: string;
  /** 1-based create attempt; caps at CREATE_MAX_ATTEMPTS (absent = 1). */
  attempt: number;
}

export interface ReconcileVoiceTranscriptPayload {
  callSid: string;
  transcriptSid: string;
  /** 1-based reconcile attempt; caps at RECONCILE_MAX_ATTEMPTS. */
  attempt: number;
}

export function parseCreateVoiceTranscriptPayload(payload: unknown): CreateVoiceTranscriptPayload {
  if (typeof payload !== 'object' || payload === null) {
    throw new Error('createVoiceTranscript: payload is not an object');
  }
  const p = payload as Partial<CreateVoiceTranscriptPayload>;
  if (typeof p.callSid !== 'string' || p.callSid.length === 0) {
    throw new Error('createVoiceTranscript: missing callSid');
  }
  if (typeof p.recordingSid !== 'string' || p.recordingSid.length === 0) {
    throw new Error('createVoiceTranscript: missing recordingSid');
  }
  // attempt is optional for backward compat with envelopes enqueued pre-cap.
  if (p.attempt !== undefined && (typeof p.attempt !== 'number' || !Number.isInteger(p.attempt) || p.attempt < 1)) {
    throw new Error('createVoiceTranscript: invalid attempt');
  }
  return { callSid: p.callSid, recordingSid: p.recordingSid, attempt: p.attempt ?? 1 };
}

export function parseReconcileVoiceTranscriptPayload(
  payload: unknown,
): ReconcileVoiceTranscriptPayload {
  if (typeof payload !== 'object' || payload === null) {
    throw new Error('reconcileVoiceTranscript: payload is not an object');
  }
  const p = payload as Partial<ReconcileVoiceTranscriptPayload>;
  if (typeof p.callSid !== 'string' || p.callSid.length === 0) {
    throw new Error('reconcileVoiceTranscript: missing callSid');
  }
  if (typeof p.transcriptSid !== 'string' || p.transcriptSid.length === 0) {
    throw new Error('reconcileVoiceTranscript: missing transcriptSid');
  }
  if (typeof p.attempt !== 'number' || !Number.isInteger(p.attempt) || p.attempt < 1) {
    throw new Error('reconcileVoiceTranscript: missing/invalid attempt');
  }
  return { callSid: p.callSid, transcriptSid: p.transcriptSid, attempt: p.attempt };
}

export interface VoiceTranscriptJobDeps {
  config?: AppConfig;
  adapter?: MessagingAdapter;
  messagesRepo?: MessagesRepo;
  events?: EventBus;
  logger?: Logger;
}

export function registerVoiceTranscriptJobHandlers(deps: VoiceTranscriptJobDeps = {}): void {
  const log = deps.logger ?? defaultLogger;
  // Lazy: config/adapter/repos touch env + DynamoDB only on first job run.
  let config = deps.config;
  let adapter = deps.adapter;
  let messages = deps.messagesRepo;
  let events = deps.events;

  const reconcileDelay = (cfg: AppConfig): { runAt: Date } => ({
    runAt: new Date(Date.now() + cfg.voiceTranscriptReconcileSeconds * 1000),
  });

  /** Stamp transcript_status failed (pending -> failed) + emit SSE (spec 3.7:
   * every transition announces live). Returns whether the stamp won. */
  const stampFailedAndEmit = async (repo: MessagesRepo, bus: EventBus, callSid: string): Promise<boolean> => {
    const stamped = await repo.setTranscriptFailed(callSid);
    if (stamped) {
      const fresh = await repo.getByProviderSid(callSid);
      if (fresh) {
        bus.emit('message.persisted', {
          conversationId: fresh.conversationId,
          tsMsgId: fresh.tsMsgId,
          direction: fresh.direction,
          deliveryStatus: fresh.delivery_status,
        });
      }
    }
    return stamped;
  };

  defineJobHandler(CREATE_VOICE_TRANSCRIPT_JOB, async (rawPayload) => {
    const payload = parseCreateVoiceTranscriptPayload(rawPayload);
    config ??= loadConfig();
    adapter ??= createMessagingAdapter({ config, logger: deps.logger });
    messages ??= createMessagesRepo({ logger: deps.logger });
    events ??= appEvents;

    // Idempotency + guardrail checks (spec 3.2 step 1): skip (success, log) on a
    // missing/non-call/masked entity, an already-transcribed call, or VI unset.
    const entry = await messages.getByProviderSid(payload.callSid);
    if (!entry || entry.type !== 'call') {
      log.info({ callSid: payload.callSid }, 'createVoiceTranscript: no founder-bridge call - skipped');
      return;
    }
    if (entry.masked === true) {
      log.info({ callSid: payload.callSid, masked: true }, 'createVoiceTranscript: masked call - skipped (never transcribed)');
      return;
    }
    if (typeof entry.transcript === 'string' && entry.transcript.length > 0) {
      log.info({ callSid: payload.callSid }, 'createVoiceTranscript: transcript already present - skipped');
      return;
    }
    const serviceSid = config.twilioViServiceSid;
    if (serviceSid === undefined) {
      log.info({ callSid: payload.callSid }, 'createVoiceTranscript: VI service SID unset - skipped');
      return;
    }

    // Explicit capped retries (planner review finding 1): an API failure
    // re-enqueues this job with attempt+1 up to CREATE_MAX_ATTEMPTS; exhaustion
    // stamps transcript_status 'failed' so the "Transcribing..." indicator can
    // never be stuck forever on a sustained VI outage. (Self-managed attempts
    // instead of throw->SQS-redelivery so the FINAL attempt is knowable and can
    // close the lifecycle; the exhaustion WARN is the operator signal.) The
    // step-1 checks above keep every retry idempotent.
    let transcriptSid: string;
    try {
      ({ transcriptSid } = await adapter.createViTranscript({
        serviceSid,
        recordingSid: payload.recordingSid,
        customerKey: payload.callSid,
      }));
    } catch (err) {
      if (payload.attempt < CREATE_MAX_ATTEMPTS) {
        await enqueue(
          CREATE_VOICE_TRANSCRIPT_JOB,
          { callSid: payload.callSid, recordingSid: payload.recordingSid, attempt: payload.attempt + 1 },
          reconcileDelay(config),
        );
        log.warn(
          { err, callSid: payload.callSid, recordingSid: payload.recordingSid, attempt: payload.attempt + 1 },
          'createVoiceTranscript: VI create failed - retry enqueued',
        );
        return;
      }
      const stamped = await stampFailedAndEmit(messages, events, payload.callSid);
      log.warn(
        { err, callSid: payload.callSid, recordingSid: payload.recordingSid, attempts: payload.attempt, stamped },
        'createVoiceTranscript: exhausted attempts - stamped transcript_status failed',
      );
      return;
    }
    await enqueue(
      RECONCILE_VOICE_TRANSCRIPT_JOB,
      { callSid: payload.callSid, transcriptSid, attempt: 1 },
      reconcileDelay(config),
    );
    log.info(
      { callSid: payload.callSid, transcriptSid },
      'createVoiceTranscript: VI transcript created, reconcile enqueued',
    );
  });

  defineJobHandler(RECONCILE_VOICE_TRANSCRIPT_JOB, async (rawPayload) => {
    const payload = parseReconcileVoiceTranscriptPayload(rawPayload);
    config ??= loadConfig();
    adapter ??= createMessagingAdapter({ config, logger: deps.logger });
    messages ??= createMessagesRepo({ logger: deps.logger });
    events ??= appEvents;

    // The webhook already won (spec 3.4 step 1): a transcript is present -> done.
    const entry = await messages.getByProviderSid(payload.callSid);
    if (entry && typeof entry.transcript === 'string' && entry.transcript.length > 0) {
      log.info(
        { callSid: payload.callSid, transcriptSid: payload.transcriptSid },
        'reconcileVoiceTranscript: transcript already present - webhook won, done',
      );
      return;
    }

    // Shared persist helper (never duplicated). Twilio API errors propagate ->
    // jobs redelivery/DLQ. Only 'not-completed' is non-terminal.
    const outcome = await persistViTranscript(
      { adapter, messages, events, logger: log },
      payload.transcriptSid,
    );
    if (outcome !== 'not-completed') return;

    if (payload.attempt < RECONCILE_MAX_ATTEMPTS) {
      await enqueue(
        RECONCILE_VOICE_TRANSCRIPT_JOB,
        { callSid: payload.callSid, transcriptSid: payload.transcriptSid, attempt: payload.attempt + 1 },
        reconcileDelay(config),
      );
      log.info(
        { callSid: payload.callSid, transcriptSid: payload.transcriptSid, attempt: payload.attempt + 1 },
        'reconcileVoiceTranscript: still in progress - re-enqueued',
      );
      return;
    }

    // Exhausted: stamp transcript_status failed (spec 3.4/3.7) + emit SSE. A very
    // late webhook can still upgrade failed -> completed (setCallTranscript
    // condition is on transcript, not status).
    const stamped = await stampFailedAndEmit(messages, events, payload.callSid);
    log.warn(
      { callSid: payload.callSid, transcriptSid: payload.transcriptSid, attempts: payload.attempt, stamped },
      'reconcileVoiceTranscript: exhausted attempts - stamped transcript_status failed',
    );
  });
}
