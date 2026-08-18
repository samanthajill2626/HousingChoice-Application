/**
 * The inbox preview line for a `type:'call'` message row (the string the voice
 * paths stamp into `conversation.last_message_preview` via touchLastActivity,
 * exactly as the text/email writers stamp the message body).
 *
 * Why STORED rather than derived at read time: every consumer of the preview -
 * the inbox row builders, the `conversation.updated` SSE payload, Today, the
 * relay row - reads `last_message_preview` off the conversation item, so a
 * stored string reaches all of them with zero read-side changes. Staff-facing
 * dashboard copy, not automated tenant/landlord messaging, so it does not go
 * through the message catalog.
 *
 * Direction wording: an inbound call is just a "call" (the business line rang);
 * an outbound call is an "Outgoing call". Voicemail wins over any status.
 */
import type { CallOutcome, CallStatus, MessageDirection } from '../repos/messagesRepo.js';

export interface CallPreviewInput {
  direction: MessageDirection;
  callStatus: CallStatus;
  callOutcome?: CallOutcome;
  /** Bridge talk time in seconds (only meaningful for an answered call). */
  callDuration?: number;
}

/** "12m 34s" / "42s"; undefined for an absent or invalid duration. */
export function formatCallDuration(seconds: number | undefined): string | undefined {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return undefined;
  const whole = Math.floor(seconds);
  const m = Math.floor(whole / 60);
  const s = whole % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

export function callPreview(input: CallPreviewInput): string {
  const outbound = input.direction === 'outbound';
  const base = outbound ? 'Outgoing call' : 'Call';
  if (input.callOutcome === 'voicemail') return 'Voicemail';
  if (input.callStatus === 'ringing') return outbound ? 'Outgoing call' : 'Incoming call';
  if (input.callStatus === 'in-progress') return `${base} in progress`;
  // Terminal.
  if (input.callOutcome === 'missed') return outbound ? 'Outgoing call - no answer' : 'Missed call';
  if (input.callOutcome === 'answered') {
    const dur = formatCallDuration(input.callDuration);
    return dur !== undefined ? `${base} - ${dur}` : base;
  }
  return base;
}
