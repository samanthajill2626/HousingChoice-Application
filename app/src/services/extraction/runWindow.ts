// The run log window records message identities and sent-byte fingerprints.
// Text is rehydrated at view time and is never logged here.
import { createHash } from 'node:crypto';
import type { TranscriptUtterance } from '../../adapters/extraction.js';
import {
  NEW_MESSAGE_CHAR_CAP,
  SEEN_MESSAGE_CHAR_CAP,
  TRUNCATION_MARKER,
  WINDOW_CHAR_BUDGET,
} from '../../jobs/extraction.js';
import { renderUtteranceLine } from './prompt.js';
import type { RunWindow, RunWindowExcluded, RunWindowMessage } from './runTypes.js';

/** The identity of one fetched message, which is all a light window needs. */
export interface LightWindowMessage {
  tsMsgId: string;
  type: string;
  direction: string;
}

/** One message's pieces as computed by the extraction job for a full window. */
export interface WindowMessagePieces extends LightWindowMessage {
  raw: TranscriptUtterance[];
  capped: TranscriptUtterance[];
  capChars: number;
}

export interface BuildLightRunWindowInput {
  cursor: string;
  fetchedCount: number;
  /** The page cap the read actually used (50 automatic, 200 manual). Taken from
   *  the caller for the same reason as maxTranscriptAgeDays: the record must
   *  describe THIS run's read. It decides windowCappedAtLimit and is stored in
   *  the full window's windowParams. */
  maxTranscriptMessages: number;
  agedOutTsMsgIds: string[];
  messages: LightWindowMessage[];
  newestTsMsgId?: string;
}

export interface BuildFullRunWindowInput extends Omit<BuildLightRunWindowInput, 'messages'> {
  perMessage: WindowMessagePieces[];
  included: Set<string>;
  hasInferredRoleContent: boolean;
  /** The floor this run actually applied; null when waived. Taken from the
   *  caller rather than the module constant so a manual run, which skips the
   *  cutoff entirely, cannot record a window it never sent. */
  maxTranscriptAgeDays: number | null;
}

/** sha256 first-16-hex over the exact rendered lines sent for one message. */
export function hashRenderedMessage(utterances: TranscriptUtterance[]): string {
  return createHash('sha256')
    .update(utterances.map(renderUtteranceLine).join('\n'), 'utf8')
    .digest('hex')
    .slice(0, 16);
}

const tierOf = (tsMsgId: string, cursor: string): 'new' | 'seen' => (tsMsgId > cursor ? 'new' : 'seen');

const cappedAtLimit = (fetchedCount: number, maxTranscriptMessages: number): boolean =>
  fetchedCount === maxTranscriptMessages;

export function buildLightRunWindow(input: BuildLightRunWindowInput): RunWindow {
  return {
    detail: 'light',
    cursor: input.cursor,
    ...(input.newestTsMsgId !== undefined && { newestTsMsgId: input.newestTsMsgId }),
    windowCappedAtLimit: cappedAtLimit(input.fetchedCount, input.maxTranscriptMessages),
    messages: input.messages.map((message) => ({ ...message, tier: tierOf(message.tsMsgId, input.cursor) })),
    excluded: input.agedOutTsMsgIds.map((tsMsgId) => ({ tsMsgId, cause: 'age_30d' as const })),
  };
}

export function buildFullRunWindow(input: BuildFullRunWindowInput): RunWindow {
  const messages: RunWindowMessage[] = [];
  const excluded: RunWindowExcluded[] = [];
  const noContent: string[] = [];
  let totalChars = 0;

  for (const tsMsgId of input.agedOutTsMsgIds) {
    excluded.push({ tsMsgId, cause: 'age_30d' });
  }

  for (const piece of input.perMessage) {
    if (piece.raw.length === 0) {
      noContent.push(piece.tsMsgId);
      continue;
    }
    if (!input.included.has(piece.tsMsgId)) {
      excluded.push({ tsMsgId: piece.tsMsgId, cause: 'char_budget' });
      continue;
    }
    const rawChars = piece.raw.reduce((total, utterance) => total + utterance.text.length, 0);
    const chars = piece.capped.reduce((total, utterance) => total + utterance.text.length, 0);
    totalChars += chars;
    messages.push({
      tsMsgId: piece.tsMsgId,
      type: piece.type,
      direction: piece.direction,
      tier: tierOf(piece.tsMsgId, input.cursor),
      capChars: piece.capChars,
      truncated: rawChars > piece.capChars,
      chars,
      hash: hashRenderedMessage(piece.capped),
    });
  }

  return {
    detail: 'full',
    cursor: input.cursor,
    ...(input.newestTsMsgId !== undefined && { newestTsMsgId: input.newestTsMsgId }),
    hasInferredRoleContent: input.hasInferredRoleContent,
    totalChars,
    windowCappedAtLimit: cappedAtLimit(input.fetchedCount, input.maxTranscriptMessages),
    windowParams: {
      newMessageCharCap: NEW_MESSAGE_CHAR_CAP,
      seenMessageCharCap: SEEN_MESSAGE_CHAR_CAP,
      windowCharBudget: WINDOW_CHAR_BUDGET,
      maxTranscriptMessages: input.maxTranscriptMessages,
      maxTranscriptAgeDays: input.maxTranscriptAgeDays,
      truncationMarker: TRUNCATION_MARKER,
    },
    messages,
    excluded,
    noContent,
  };
}
