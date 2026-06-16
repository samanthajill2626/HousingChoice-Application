// CallEntry (M1.9) — a voice-call timeline item. A call is NOT a chat bubble:
// it renders as a centered metadata row (phone glyph + masked party label +
// direction + an outcome Badge + the duration when answered), so it reads as an
// event in the conversation rather than a message someone typed.
//
// Honest identity / PII (doc §9): the label is the backend's MASKED
// call_party_label (a role/name) — we render it verbatim and NEVER a raw
// counterpart phone. A MASKED relay call (masked === true) shows metadata ONLY.
//
// Founder-bridge calls (masked === false) MAY carry a recording + transcript;
// we render the <audio> player and the collapsible transcript ONLY when those
// fields are actually present (defensive — never assume a masked call has them).
// The recording streams from the auth-gated same-origin endpoint via
// callRecordingUrl (cookie auth; the audio bytes never transit a public URL).
import { useState } from 'react';
import { Badge, PhoneIcon, type BadgeTone } from '../../ui';
import { callRecordingUrl, type CallOutcome, type Message } from '../../api';
import styles from './CallEntry.module.css';

export interface CallEntryProps {
  /** A `type:'call'` timeline message. */
  message: Message;
}

/** Outcome → badge tone + label. answered=success / missed=warning / voicemail=neutral. */
const OUTCOME_PRESENTATION: Record<CallOutcome, { tone: BadgeTone; label: string }> = {
  answered: { tone: 'success', label: 'Answered' },
  missed: { tone: 'warning', label: 'Missed' },
  voicemail: { tone: 'neutral', label: 'Voicemail' },
};

/** Format whole seconds as m:ss (e.g. 75 → "1:15"). */
export function formatDuration(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(safe / 60);
  const seconds = safe % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

export function CallEntry({ message }: CallEntryProps): React.JSX.Element {
  const [transcriptOpen, setTranscriptOpen] = useState(false);

  const inbound = message.direction === 'inbound';
  const directionLabel = inbound ? 'Inbound call' : 'Outbound call';
  // Honest identity: render the masked label verbatim; fall back to a neutral
  // word (never a phone) when the server didn't supply one.
  const partyLabel =
    typeof message.call_party_label === 'string' && message.call_party_label.length > 0
      ? message.call_party_label
      : 'Unknown party';

  const outcome = message.call_outcome;
  const outcomePresentation = outcome !== undefined ? OUTCOME_PRESENTATION[outcome] : undefined;

  // Duration only reads meaningfully on an answered call.
  const showDuration =
    outcome === 'answered' &&
    typeof message.call_duration === 'number' &&
    message.call_duration > 0;

  // Defensive: recording/transcript controls render ONLY when the fields are
  // present (a masked relay call never has them). The PRESENCE of the
  // recording_s3_key is the signal a playable recording exists.
  const hasRecording =
    typeof message.recording_s3_key === 'string' && message.recording_s3_key.length > 0;
  const hasTranscript =
    typeof message.transcript === 'string' && message.transcript.length > 0;

  return (
    <li className={styles.row}>
      <div className={styles.card} aria-label={`${directionLabel} with ${partyLabel}`}>
        <div className={styles.meta}>
          <span className={styles.icon} aria-hidden="true">
            <PhoneIcon size={16} />
          </span>
          <span className={styles.party}>{partyLabel}</span>
          <span className={styles.direction}>{directionLabel}</span>
          {outcomePresentation !== undefined && (
            <Badge tone={outcomePresentation.tone} dot>
              {outcomePresentation.label}
            </Badge>
          )}
          {showDuration && (
            <span className={styles.duration} aria-label="Call duration">
              {formatDuration(message.call_duration as number)}
            </span>
          )}
        </div>

        {/* Founder-bridge recording playback (masked calls never reach here —
         *  they carry no recording_s3_key). Streamed from the auth-gated
         *  same-origin endpoint; the <audio> request sends the session cookie. */}
        {hasRecording && (
          <audio
            className={styles.audio}
            controls
            preload="none"
            src={callRecordingUrl(message.provider_sid)}
          >
            Your browser does not support audio playback.
          </audio>
        )}

        {/* Verbatim transcript (founder-bridge only), collapsed by default. */}
        {hasTranscript && (
          <div className={styles.transcript}>
            <button
              type="button"
              className={styles.transcriptToggle}
              aria-expanded={transcriptOpen}
              onClick={() => setTranscriptOpen((open) => !open)}
            >
              {transcriptOpen ? 'Hide transcript' : 'Transcript'}
            </button>
            {transcriptOpen && (
              <p className={styles.transcriptText}>{message.transcript}</p>
            )}
          </div>
        )}
      </div>
    </li>
  );
}
