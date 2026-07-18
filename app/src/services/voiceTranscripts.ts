// Voice Intelligence transcript persistence (voice-transcription spec 3.3-3.5).
// Shared by the completion webhook (POST /voice/intelligence) and the reconcile
// job: both fetch a VI transcript by sid, join its sentences into verbatim text,
// and persist through the existing idempotent setCallTranscript seam. Keeping
// the flow here (one helper) means the webhook and reconcile legs can never
// drift - whichever runs first wins; the other no-ops on never-overwrite.
//
// PII (doc section 9): NEVER log the transcript / sentence text - lengths + sids
// only. Twilio API errors are NOT caught here; they THROW so the caller decides
// (the webhook 500s for redelivery; the job redelivers/DLQs).
import type { MessagingAdapter, ViSentence } from '../adapters/messaging.js';
import type { MessagesRepo, MessageItem } from '../repos/messagesRepo.js';
import type { EventBus } from '../lib/events.js';
import type { Logger } from '../lib/logger.js';

/**
 * Join VI sentences into the stored verbatim transcript (spec 3.5). A single
 * media channel (voicemail: the caller only) joins the sentence texts with
 * newlines and NO prefix. More than one distinct channel (a dual-channel bridge
 * recording) prefixes each line `Speaker <n>: ` where n is the 1-based order of
 * that channel's FIRST appearance - stable and channel-number-agnostic (the raw
 * Twilio channel ints are not assumed to be 1/2 or ordered).
 */
export function joinViSentences(sentences: ViSentence[]): string {
  const distinctChannels = new Set(sentences.map((s) => s.mediaChannel));
  if (distinctChannels.size <= 1) {
    return sentences.map((s) => s.text).join('\n');
  }
  const speakerOrder = new Map<number, number>();
  for (const s of sentences) {
    if (!speakerOrder.has(s.mediaChannel)) speakerOrder.set(s.mediaChannel, speakerOrder.size + 1);
  }
  return sentences.map((s) => `Speaker ${speakerOrder.get(s.mediaChannel)}: ${s.text}`).join('\n');
}

export interface PersistViTranscriptDeps {
  adapter: Pick<MessagingAdapter, 'fetchViTranscript' | 'listViSentences'>;
  messages: MessagesRepo;
  events: EventBus;
  logger: Logger;
}

/**
 * The outcome of a persist attempt, so the reconcile job can decide whether to
 * keep polling: only 'not-completed' is non-terminal (re-check later).
 */
export type PersistViOutcome =
  | 'saved'
  | 'already-saved'
  | 'not-ours'
  | 'masked-refused'
  | 'not-completed'
  | 'failed-stamped';

/** Emit the SSE update so an open thread reflects the transcript transition live. */
function emitPersisted(events: EventBus, entry: MessageItem): void {
  events.emit('message.persisted', {
    conversationId: entry.conversationId,
    tsMsgId: entry.tsMsgId,
    direction: entry.direction,
    deliveryStatus: entry.delivery_status,
  });
}

/**
 * Fetch a VI transcript by sid, resolve OUR call via its CustomerKey ONLY (spec
 * 3.3: there is no index to resolve a recording sid without a scan), and persist
 * its joined sentences via setCallTranscript. Status branches:
 *   - failed         -> setTranscriptFailed (emit on the transition), 'failed-stamped'
 *   - non-completed  -> 'not-completed' (the reconcile job is the safety net)
 *   - completed      -> resolve the call entity (missing / not a call -> 'not-ours';
 *                       masked -> 'masked-refused'); join sentences; setCallTranscript
 *                       (false -> 'already-saved'; true -> emit + 'saved').
 * Twilio API errors (fetch/list) propagate - callers redeliver.
 */
export async function persistViTranscript(
  deps: PersistViTranscriptDeps,
  transcriptSid: string,
): Promise<PersistViOutcome> {
  const { adapter, messages, events, logger } = deps;
  const summary = await adapter.fetchViTranscript(transcriptSid);
  const callSid = summary.customerKey;
  if (callSid === undefined || callSid.length === 0) {
    logger.warn({ transcriptSid }, 'vi transcript: no customerKey - not ours, ignored');
    return 'not-ours';
  }

  // Resolve OUR call FIRST - every status branch below (including the failed
  // stamp) must sit behind the not-ours and masked guardrails, not lean on the
  // conditional write being a no-op (defense-in-depth, planner review nit 3).
  const entry = await messages.getByProviderSid(callSid);
  if (!entry || entry.type !== 'call') {
    logger.warn({ transcriptSid, callSid }, 'vi transcript: no founder-bridge call for customerKey - not ours');
    return 'not-ours';
  }
  if (entry.masked === true) {
    // GUARDRAIL: masked relay calls are NEVER transcribed - refuse even a stray
    // VI event whose customerKey points at one.
    logger.warn({ transcriptSid, callSid, masked: true }, 'vi transcript for a MASKED call - refused');
    return 'masked-refused';
  }

  if (summary.status === 'failed') {
    const stamped = await messages.setTranscriptFailed(callSid);
    if (stamped) emitPersisted(events, entry);
    logger.info({ transcriptSid, callSid, stamped }, 'vi transcript: reported failed - transcript_status stamped');
    return 'failed-stamped';
  }
  if (summary.status !== 'completed') {
    logger.info(
      { transcriptSid, callSid, status: summary.status },
      'vi transcript: not completed yet - reconcile is the safety net',
    );
    return 'not-completed';
  }

  const sentences = await adapter.listViSentences(transcriptSid);
  const text = joinViSentences(sentences);
  const saved = await messages.setCallTranscript(callSid, text);
  if (saved) {
    emitPersisted(events, entry);
    // PII: transcriptLength only - NEVER the text.
    logger.info({ transcriptSid, callSid, transcriptLength: text.length }, 'vi transcript saved');
    return 'saved';
  }
  logger.info({ transcriptSid, callSid }, 'vi transcript: already saved (never-overwrite) - no-op');
  return 'already-saved';
}
