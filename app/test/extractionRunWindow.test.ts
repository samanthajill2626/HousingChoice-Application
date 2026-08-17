// Window fidelity (design 6.1, 6.3 as amended). Two shapes: LIGHT for skips,
// FULL once the model is actually going to be called.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { TranscriptUtterance } from '../src/adapters/extraction.js';
import {
  MAX_TRANSCRIPT_AGE_DAYS,
  MAX_TRANSCRIPT_MESSAGES,
  NEW_MESSAGE_CHAR_CAP,
  SEEN_MESSAGE_CHAR_CAP,
  TRUNCATION_MARKER,
  WINDOW_CHAR_BUDGET,
} from '../src/jobs/extraction.js';
import { buildExtractionUserContent, renderUtteranceLine } from '../src/services/extraction/prompt.js';
import {
  buildFullRunWindow,
  buildLightRunWindow,
  hashRenderedMessage,
} from '../src/services/extraction/runWindow.js';

const SMS_ID = '2026-08-06T10:00:00.000Z#s1';
const CALL_ID = '2026-08-06T10:05:00.000Z#c2';
const EMAIL_ID = '2026-08-06T10:09:00.000Z#e3';

function utt(
  tsMsgId: string,
  at: string,
  text: string,
  over: Partial<TranscriptUtterance> = {},
): TranscriptUtterance {
  return { tsMsgId, speaker: 'client', text, at, channel: 'sms', ...over };
}

/** A three-message window whose MIDDLE message is a two-line call. */
function multiMessagePieces() {
  const sms = [utt(SMS_ID, '2026-08-06T10:00:00.000Z', 'hello there')];
  const call = [
    utt(CALL_ID, '2026-08-06T10:05:00.000Z', 'how can I help', { speaker: 'staff', channel: 'voice' }),
    utt(CALL_ID, '2026-08-06T10:05:00.000Z', 'I need a 2 bedroom', { channel: 'voice' }),
  ];
  const email = [utt(EMAIL_ID, '2026-08-06T10:09:00.000Z', 'sending my docs', { channel: 'email' })];
  return [
    { tsMsgId: SMS_ID, type: 'sms', direction: 'inbound', raw: sms, capped: sms, capChars: NEW_MESSAGE_CHAR_CAP },
    { tsMsgId: CALL_ID, type: 'call', direction: 'inbound', raw: call, capped: call, capChars: NEW_MESSAGE_CHAR_CAP },
    { tsMsgId: EMAIL_ID, type: 'email', direction: 'inbound', raw: email, capped: email, capChars: NEW_MESSAGE_CHAR_CAP },
  ];
}

describe('hashRenderedMessage', () => {
  it('is sha256 first-16-hex over renderUtteranceLine output joined by ONE newline', () => {
    const a = utt(SMS_ID, '2026-08-06T10:00:00.000Z', 'line a');
    const b = utt(SMS_ID, '2026-08-06T10:00:00.000Z', 'line b');
    expect(hashRenderedMessage([a, b])).toBe(
      createHash('sha256')
        .update([renderUtteranceLine(a), renderUtteranceLine(b)].join('\n'), 'utf8')
        .digest('hex')
        .slice(0, 16),
    );
    expect(hashRenderedMessage([a, b])).toHaveLength(16);
  });

  it('round trips a multi-message window including a call through the request bytes', () => {
    const pieces = multiMessagePieces();
    const transcript = pieces.flatMap((piece) => piece.capped);
    const user = buildExtractionUserContent({
      profile: { contactType: 'tenant', phones: [] },
      transcript,
    });
    const body = user.slice(user.indexOf('TRANSCRIPT\n') + 'TRANSCRIPT\n'.length);
    const renderedLines = body.split('\n');

    let cursor = 0;
    for (const piece of pieces) {
      const slice = renderedLines.slice(cursor, cursor + piece.capped.length);
      expect(slice).toEqual(piece.capped.map(renderUtteranceLine));
      expect(hashRenderedMessage(piece.capped)).toBe(
        createHash('sha256').update(slice.join('\n'), 'utf8').digest('hex').slice(0, 16),
      );
      cursor += piece.capped.length;
    }
    expect(cursor).toBe(renderedLines.length);
  });

  it('records the same hashes in a full window', () => {
    const pieces = multiMessagePieces();
    const window = buildFullRunWindow({
      cursor: '',
      fetchedCount: 3,
      agedOutTsMsgIds: [],
      perMessage: pieces,
      included: new Set([SMS_ID, CALL_ID, EMAIL_ID]),
      hasInferredRoleContent: false,
      maxTranscriptAgeDays: MAX_TRANSCRIPT_AGE_DAYS,
      newestTsMsgId: EMAIL_ID,
    });
    expect(window.messages.map((message) => message.hash)).toEqual(
      pieces.map((piece) => hashRenderedMessage(piece.capped)),
    );
  });
});

describe('buildLightRunWindow', () => {
  it('records identity, tier, cursor, age exclusions, and no byte-shaped fields', () => {
    const window = buildLightRunWindow({
      cursor: SMS_ID,
      fetchedCount: 2,
      agedOutTsMsgIds: ['2026-07-01T00:00:00.000Z#s0'],
      messages: [
        { tsMsgId: SMS_ID, type: 'sms', direction: 'inbound' },
        { tsMsgId: CALL_ID, type: 'call', direction: 'inbound' },
      ],
      newestTsMsgId: CALL_ID,
    });
    expect(window).toMatchObject({
      detail: 'light',
      cursor: SMS_ID,
      newestTsMsgId: CALL_ID,
      windowCappedAtLimit: false,
      messages: [
        { tsMsgId: SMS_ID, type: 'sms', direction: 'inbound', tier: 'seen' },
        { tsMsgId: CALL_ID, type: 'call', direction: 'inbound', tier: 'new' },
      ],
      excluded: [{ tsMsgId: '2026-07-01T00:00:00.000Z#s0', cause: 'age_30d' }],
    });
    expect(window.totalChars).toBeUndefined();
    expect(window.windowParams).toBeUndefined();
    expect(window.noContent).toBeUndefined();
    expect(window.hasInferredRoleContent).toBeUndefined();
    expect(window.messages.every((message) => message.hash === undefined && message.chars === undefined)).toBe(true);
  });

  it('flags the fetch cap only when the returned row count equals the cap', () => {
    const base = { cursor: '', agedOutTsMsgIds: [], messages: [] };
    expect(buildLightRunWindow({ ...base, fetchedCount: MAX_TRANSCRIPT_MESSAGES }).windowCappedAtLimit).toBe(true);
    expect(buildLightRunWindow({ ...base, fetchedCount: MAX_TRANSCRIPT_MESSAGES - 1 }).windowCappedAtLimit).toBe(false);
  });

  it('records an honest empty window', () => {
    const window = buildLightRunWindow({ cursor: 'c', fetchedCount: 0, agedOutTsMsgIds: [], messages: [] });
    expect(window).toMatchObject({
      detail: 'light',
      cursor: 'c',
      messages: [],
      excluded: [],
      windowCappedAtLimit: false,
    });
    expect(window.newestTsMsgId).toBeUndefined();
  });
});

describe('buildFullRunWindow', () => {
  it('records the byte-affecting constants', () => {
    const window = buildFullRunWindow({
      cursor: '',
      fetchedCount: 3,
      agedOutTsMsgIds: [],
      perMessage: multiMessagePieces(),
      included: new Set([SMS_ID, CALL_ID, EMAIL_ID]),
      hasInferredRoleContent: false,
      maxTranscriptAgeDays: MAX_TRANSCRIPT_AGE_DAYS,
    });
    expect(window).toMatchObject({
      detail: 'full',
      windowParams: {
        newMessageCharCap: NEW_MESSAGE_CHAR_CAP,
        seenMessageCharCap: SEEN_MESSAGE_CHAR_CAP,
        windowCharBudget: WINDOW_CHAR_BUDGET,
        maxTranscriptMessages: MAX_TRANSCRIPT_MESSAGES,
        maxTranscriptAgeDays: MAX_TRANSCRIPT_AGE_DAYS,
        truncationMarker: TRUNCATION_MARKER,
      },
    });
  });

  it('tags tier and the exact capChars applied to each message', () => {
    const [sms, call] = multiMessagePieces();
    const window = buildFullRunWindow({
      cursor: SMS_ID,
      fetchedCount: 2,
      agedOutTsMsgIds: [],
      perMessage: [{ ...sms!, capChars: SEEN_MESSAGE_CHAR_CAP }, call!],
      included: new Set([SMS_ID, CALL_ID]),
      hasInferredRoleContent: false,
      maxTranscriptAgeDays: MAX_TRANSCRIPT_AGE_DAYS,
    });
    expect(window.messages.map((message) => [message.tier, message.capChars])).toEqual([
      ['seen', SEEN_MESSAGE_CHAR_CAP],
      ['new', NEW_MESSAGE_CHAR_CAP],
    ]);
  });

  it('marks truncated after capping shortened a message', () => {
    const long = utt(SMS_ID, '2026-08-06T10:00:00.000Z', 'x'.repeat(SEEN_MESSAGE_CHAR_CAP + 100));
    const clipped = utt(SMS_ID, '2026-08-06T10:00:00.000Z', 'x'.repeat(SEEN_MESSAGE_CHAR_CAP));
    const window = buildFullRunWindow({
      cursor: 'zzz',
      fetchedCount: 1,
      agedOutTsMsgIds: [],
      perMessage: [{ tsMsgId: SMS_ID, type: 'sms', direction: 'inbound', raw: [long], capped: [clipped], capChars: SEEN_MESSAGE_CHAR_CAP }],
      included: new Set([SMS_ID]),
      hasInferredRoleContent: false,
      maxTranscriptAgeDays: MAX_TRANSCRIPT_AGE_DAYS,
    });
    expect(window.messages[0]!.truncated).toBe(true);
    expect(window.messages[0]!.chars).toBe(SEEN_MESSAGE_CHAR_CAP);
  });

  it('separates age and char-budget exclusion causes', () => {
    const [sms, call] = multiMessagePieces();
    const window = buildFullRunWindow({
      cursor: '',
      fetchedCount: 3,
      agedOutTsMsgIds: ['old#1'],
      perMessage: [sms!, call!],
      included: new Set([CALL_ID]),
      hasInferredRoleContent: false,
      maxTranscriptAgeDays: MAX_TRANSCRIPT_AGE_DAYS,
    });
    expect(window.excluded).toEqual([
      { tsMsgId: 'old#1', cause: 'age_30d' },
      { tsMsgId: SMS_ID, cause: 'char_budget' },
    ]);
  });

  it('records zero-utterance included messages as noContent and never as read', () => {
    const [sms] = multiMessagePieces();
    const window = buildFullRunWindow({
      cursor: '',
      fetchedCount: 2,
      agedOutTsMsgIds: [],
      perMessage: [
        { tsMsgId: CALL_ID, type: 'call', direction: 'inbound', raw: [], capped: [], capChars: NEW_MESSAGE_CHAR_CAP },
        sms!,
      ],
      included: new Set([CALL_ID, SMS_ID]),
      hasInferredRoleContent: false,
      maxTranscriptAgeDays: MAX_TRANSCRIPT_AGE_DAYS,
    });
    expect(window.noContent).toEqual([CALL_ID]);
    expect(window.messages.map((message) => message.tsMsgId)).toEqual([SMS_ID]);
    expect(window.excluded.some((excluded) => excluded.tsMsgId === CALL_ID)).toBe(false);
  });

  it('sums only the characters that reached the model', () => {
    const window = buildFullRunWindow({
      cursor: '',
      fetchedCount: 2,
      agedOutTsMsgIds: [],
      perMessage: [
        { tsMsgId: 'a#1', type: 'sms', direction: 'inbound', raw: [utt('a#1', '2026-08-06T10:00:00.000Z', 'aaaa')], capped: [utt('a#1', '2026-08-06T10:00:00.000Z', 'aaaa')], capChars: NEW_MESSAGE_CHAR_CAP },
        { tsMsgId: 'b#1', type: 'sms', direction: 'inbound', raw: [utt('b#1', '2026-08-06T10:01:00.000Z', 'bb')], capped: [utt('b#1', '2026-08-06T10:01:00.000Z', 'bb')], capChars: NEW_MESSAGE_CHAR_CAP },
      ],
      included: new Set(['b#1']),
      hasInferredRoleContent: false,
      maxTranscriptAgeDays: MAX_TRANSCRIPT_AGE_DAYS,
    });
    expect(window.totalChars).toBe(2);
  });

  it('records a null age floor when the run waived it', () => {
    // Same input as 'records the byte-affecting constants' with the one field
    // overridden: a manual run applies NO age floor, and the record must say so
    // rather than echoing a constant the run never used.
    const window = buildFullRunWindow({
      cursor: '',
      fetchedCount: 3,
      agedOutTsMsgIds: [],
      perMessage: multiMessagePieces(),
      included: new Set([SMS_ID, CALL_ID, EMAIL_ID]),
      hasInferredRoleContent: false,
      maxTranscriptAgeDays: null,
    });
    expect(window.windowParams!.maxTranscriptAgeDays).toBeNull();
    // The other byte-affecting constants are untouched by the waiver.
    expect(window.windowParams!.maxTranscriptMessages).toBe(MAX_TRANSCRIPT_MESSAGES);
  });
});
