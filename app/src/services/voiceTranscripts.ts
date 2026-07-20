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
import type { createExtractionRepo } from '../repos/extractionRepo.js';

/**
 * A source-attributed channel->role map (voice-extraction Layer 1): keys are the
 * raw VI mediaChannel ints as strings ("1"/"2"), values the KNOWN speaker role
 * for that channel. Stamped onto the call item at append time by the two dial
 * sites (inbound founder bridge / outbound originate) whose leg orientation is
 * deterministic at ring time.
 */
export type ChannelRoles = Record<string, 'staff' | 'client'>;

/**
 * Join VI sentences into the stored verbatim transcript (spec 3.5).
 *
 * Layer 1 role prefixes apply ONLY to a genuine DUAL-channel bridge recording
 * (2+ distinct channels) whose `roles` map covers EVERY distinct channel: each
 * line is prefixed `Staff: `/`Client: ` by the RAW mediaChannel int
 * (String(mediaChannel)) - NOT the Speaker-N ordinal (voice-extraction Layer 1).
 * A partial/absent map - OR a SINGLE-channel recording - degrades gracefully to
 * the legacy labels below (never block a transcript on attribution).
 *
 * Single-channel note: a platform voicemail RIDES the same inbound founder-bridge
 * call item, which is stamped { "1":"client", "2":"staff" } at ring time - so its
 * item DOES carry a roles map (the plan's "voicemail has no map" assumption is
 * false). We still join it UNPREFIXED: the caller is the client by construction
 * (spec section 4), and T3 maps an unprefixed voice line to 'client'. Requiring
 * 2+ distinct channels is what keeps a voicemail unprefixed despite the map.
 *
 * Legacy labels: a single media channel (voicemail: the caller only) joins the
 * sentence texts with newlines and NO prefix. More than one distinct channel (a
 * dual-channel bridge recording) prefixes each line `Speaker <n>: ` where n is
 * the 1-based order of that channel's FIRST appearance - stable and
 * channel-number-agnostic (the raw Twilio channel ints are not assumed to be
 * 1/2 or ordered).
 */
export function joinViSentences(sentences: ViSentence[], roles?: ChannelRoles): string {
  // The joined blob uses '\n' as the per-TURN / speaker-line delimiter, and
  // toUtterances re-splits on '\n' (defaulting an unprefixed line to 'client').
  // A newline INSIDE one VI sentence's text would therefore orphan a fragment
  // onto its own line and mis-attribute it - on an attributed dual-channel call
  // a staff fragment would default to 'client' and, with no Speaker N line to
  // trip demotion, be silently direct-written. Flatten intra-sentence newlines
  // so the invariant "one turn -> exactly one line" holds in every branch.
  const flat = (t: string): string => t.replace(/[\r\n]+/g, ' ');
  // TURN-GROUPING (operator feedback 2026-07-20): VI starts a new sentence at
  // every small pause, so an uninterrupted speaker used to produce a stack of
  // one-sentence lines. Merge CONSECUTIVE same-channel sentences into one turn -
  // the line breaks only when the speaker changes. Words stay verbatim
  // (formatting only), and toUtterances' one-prefix-per-line contract is
  // unchanged: an utterance is now a full turn instead of a sentence fragment
  // (better extraction context, same parsing).
  const turns: Array<{ channel: number; texts: string[] }> = [];
  for (const s of sentences) {
    const last = turns[turns.length - 1];
    if (last !== undefined && last.channel === s.mediaChannel) last.texts.push(flat(s.text));
    else turns.push({ channel: s.mediaChannel, texts: [flat(s.text)] });
  }
  const turnText = (t: { texts: string[] }): string => t.texts.join(' ');
  const distinctChannels = new Set(sentences.map((s) => s.mediaChannel));
  // Source-attributed roles win when present AND total (every distinct channel
  // mapped) AND the recording is genuinely dual-channel (2+ distinct channels).
  // A single-channel recording (a platform voicemail, or a one-sided bridge)
  // stays legacy-unprefixed even though the bridge item carries a
  // { "1":"client","2":"staff" } map - the caller is the client by construction
  // (spec 4). Look up by the RAW channel int-as-string so the label matches who
  // spoke regardless of channel order.
  if (
    roles !== undefined &&
    distinctChannels.size >= 2 &&
    [...distinctChannels].every((c) => roles[String(c)] !== undefined)
  ) {
    return turns
      .map((t) => `${roles[String(t.channel)] === 'staff' ? 'Staff' : 'Client'}: ${turnText(t)}`)
      .join('\n');
  }
  if (distinctChannels.size <= 1) {
    // One speaker -> one turn -> ONE line (a voicemail is a single paragraph).
    return turns.map(turnText).join('\n');
  }
  const speakerOrder = new Map<number, number>();
  for (const t of turns) {
    if (!speakerOrder.has(t.channel)) speakerOrder.set(t.channel, speakerOrder.size + 1);
  }
  return turns.map((t) => `Speaker ${speakerOrder.get(t.channel)}: ${turnText(t)}`).join('\n');
}

export interface PersistViTranscriptDeps {
  adapter: Pick<MessagingAdapter, 'fetchViTranscript' | 'listViSentences'>;
  messages: MessagesRepo;
  events: EventBus;
  logger: Logger;
  /**
   * Conversation fact extraction (voice-extraction T2): a fresh transcript save
   * schedules an IMMEDIATE (no-debounce) extraction run so the AI pipeline sees
   * the new call text. Optional - the helper degrades to a pure persist when it
   * is unwired. Gated by aiExtractionEnabled.
   */
  extraction?: Pick<ReturnType<typeof createExtractionRepo>, 'scheduleExtraction'>;
  /** Kill switch (config.aiExtractionEnabled): OFF skips the hook entirely. */
  aiExtractionEnabled: boolean;
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
  // Source-attributed channel roles (voice-extraction Layer 1) are stamped onto
  // this call item at append time by our OWN dial sites (inbound voice.ts /
  // outbound originateCall.ts) - a fixed { "1"|"2": "staff"|"client" } shape - so
  // reading it back off the item's index-signature attr as ChannelRoles is sound.
  // joinViSentences degrades to legacy labels when it is absent (voicemail/legacy).
  const roles = entry.transcript_channel_roles as ChannelRoles | undefined;
  const text = joinViSentences(sentences, roles);
  const saved = await messages.setCallTranscript(callSid, text);
  if (saved) {
    emitPersisted(events, entry);
    // PII: transcriptLength only - NEVER the text.
    logger.info({ transcriptSid, callSid, transcriptLength: text.length }, 'vi transcript saved');
    // Voice-extraction T2: schedule an IMMEDIATE (no-debounce) extraction run so
    // the AI pipeline picks up the new call text. Best-effort + kill-switch-gated:
    // a schedule failure NEVER changes the 'saved' outcome. Fires ONLY on this
    // fresh-save branch (already-saved/not-ours/masked/failed/not-completed all
    // returned earlier); no conversation-type lookup here - the extraction job's
    // contact-type guard already no-ops landlord/team/relay threads.
    if (deps.aiExtractionEnabled && deps.extraction) {
      try {
        await deps.extraction.scheduleExtraction(entry.conversationId, 'voice', new Date().toISOString());
      } catch (err) {
        // PII: sids + err only - NEVER the transcript text or message bodies.
        logger.warn(
          { transcriptSid, callSid, err },
          'vi transcript: scheduleExtraction failed (saved regardless)',
        );
      }
    }
    return 'saved';
  }
  logger.info({ transcriptSid, callSid }, 'vi transcript: already saved (never-overwrite) - no-op');
  return 'already-saved';
}
