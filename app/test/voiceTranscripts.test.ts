// Unit tests for joinViSentences role-aware rendering (voice-extraction Layer 1,
// spec 2026-07-18-voice-extraction-adapter-design.md section 3). joinViSentences
// is the single funnel both the VI completion webhook and the reconcile job flow
// through; these pin the three render modes:
//   - a FULL source-attributed role map -> 'Staff: '/'Client: ' prefixes, keyed
//     by the RAW mediaChannel int-as-string (order- and int-agnostic);
//   - a PARTIAL or ABSENT map -> EXACTLY today's legacy 'Speaker N: ' labels by
//     first-appearance order (graceful degrade - never block on attribution);
//   - a single distinct channel (voicemail) with no map -> unprefixed join.
// PII (voice standing rule): the sample texts here are synthetic, never real
// transcript content.
import { describe, it, expect } from 'vitest';
import { joinViSentences, type ChannelRoles } from '../src/services/voiceTranscripts.js';
import type { ViSentence } from '../src/adapters/messaging.js';

describe('joinViSentences role-aware rendering (voice-extraction Layer 1)', () => {
  it('renders Staff:/Client: prefixes when EVERY distinct channel is mapped - regardless of raw channel ints or order', () => {
    // channel 2 appears FIRST, channel 1 SECOND: the role is looked up by the RAW
    // mediaChannel (String(2)/String(1)), NOT the first-appearance ordinal. So the
    // first line (channel 2 -> staff) renders 'Staff: ', not 'Speaker 1: '.
    const sentences: ViSentence[] = [
      { text: 'hello', mediaChannel: 2 },
      { text: 'hi', mediaChannel: 1 },
    ];
    const roles: ChannelRoles = { '1': 'client', '2': 'staff' };
    expect(joinViSentences(sentences, roles)).toBe('Staff: hello\nClient: hi');
  });

  it('maps ARBITRARY (non-1/2) channel ints by their string key', () => {
    const sentences: ViSentence[] = [
      { text: 'a', mediaChannel: 7 },
      { text: 'b', mediaChannel: 3 },
      { text: 'c', mediaChannel: 7 },
    ];
    const roles: ChannelRoles = { '3': 'client', '7': 'staff' };
    expect(joinViSentences(sentences, roles)).toBe('Staff: a\nClient: b\nStaff: c');
  });

  it('falls back to legacy Speaker N labels when the map is PARTIAL (a distinct channel is unmapped)', () => {
    const sentences: ViSentence[] = [
      { text: 'hello', mediaChannel: 1 },
      { text: 'hi', mediaChannel: 2 },
    ];
    // channel 2 has no role -> NOT every distinct channel is mapped -> legacy.
    const roles: ChannelRoles = { '1': 'client' };
    expect(joinViSentences(sentences, roles)).toBe('Speaker 1: hello\nSpeaker 2: hi');
  });

  it('falls back to legacy Speaker N labels when NO map is supplied (dual channel)', () => {
    const sentences: ViSentence[] = [
      { text: 'hello', mediaChannel: 1 },
      { text: 'hi', mediaChannel: 2 },
    ];
    expect(joinViSentences(sentences)).toBe('Speaker 1: hello\nSpeaker 2: hi');
  });

  // REGRESSION (adversarial review, slice 2): a newline INSIDE one VI sentence must
  // NOT orphan a fragment onto its own line - the blob's '\n' is the speaker
  // delimiter ONLY, so downstream toUtterances (which splits on '\n' and defaults an
  // unprefixed line to 'client') can never mis-attribute a staff fragment as client
  // and silently direct-write it. The invariant: one ViSentence -> exactly one line.
  it('flattens an intra-sentence newline so one attributed sentence stays one line', () => {
    const sentences: ViSentence[] = [
      { text: 'I own\nthree units', mediaChannel: 2 },
      { text: 'ok', mediaChannel: 1 },
    ];
    const roles: ChannelRoles = { '1': 'client', '2': 'staff' };
    const blob = joinViSentences(sentences, roles);
    // Exactly two lines, each a real speaker line - no orphaned 'three units'.
    expect(blob).toBe('Staff: I own three units\nClient: ok');
    for (const line of blob.split('\n')) {
      expect(/^(Staff|Client): /.test(line)).toBe(true);
    }
  });

  it('flattens intra-sentence newlines in the legacy Speaker N and voicemail paths too', () => {
    const dual: ViSentence[] = [
      { text: 'line one\nline two', mediaChannel: 1 },
      { text: 'reply', mediaChannel: 2 },
    ];
    expect(joinViSentences(dual)).toBe('Speaker 1: line one line two\nSpeaker 2: reply');
    const voicemail: ViSentence[] = [{ text: 'call me\nabout the unit', mediaChannel: 1 }];
    expect(joinViSentences(voicemail)).toBe('call me about the unit');
  });

  it('a single distinct channel with no map joins UNPREFIXED as ONE turn (legacy/underivable call)', () => {
    const sentences: ViSentence[] = [
      { text: 'please call me back', mediaChannel: 1 },
      { text: 'it is about the unit', mediaChannel: 1 },
    ];
    // One speaker -> one TURN -> one line (turn-grouping, 2026-07-20): a pause
    // mid-voicemail must not fragment the message across lines.
    expect(joinViSentences(sentences)).toBe('please call me back it is about the unit');
  });

  // TURN-GROUPING (operator feedback 2026-07-20): VI emits a new sentence at every
  // small pause, so an uninterrupted speaker produced a stack of one-sentence lines.
  // Consecutive same-channel sentences now merge into ONE labeled turn line; the
  // line only breaks when the SPEAKER changes. Words stay verbatim (formatting
  // only), and the one-prefix-per-line contract toUtterances parses is unchanged -
  // an utterance is now a full turn, not a sentence fragment.
  it('merges consecutive same-channel sentences into one Staff:/Client: turn line', () => {
    const sentences: ViSentence[] = [
      { text: 'hello there', mediaChannel: 2 },
      { text: 'thanks for calling', mediaChannel: 2 },
      { text: 'how can I help', mediaChannel: 2 },
      { text: 'I am calling about the unit', mediaChannel: 1 },
      { text: 'the two bedroom', mediaChannel: 1 },
      { text: 'great, let me look', mediaChannel: 2 },
    ];
    const roles: ChannelRoles = { '1': 'client', '2': 'staff' };
    expect(joinViSentences(sentences, roles)).toBe(
      'Staff: hello there thanks for calling how can I help\n' +
        'Client: I am calling about the unit the two bedroom\n' +
        'Staff: great, let me look',
    );
  });

  it('merges consecutive same-channel sentences in the legacy Speaker N path too', () => {
    const sentences: ViSentence[] = [
      { text: 'one', mediaChannel: 1 },
      { text: 'two', mediaChannel: 1 },
      { text: 'reply', mediaChannel: 2 },
      { text: 'three', mediaChannel: 1 },
    ];
    expect(joinViSentences(sentences)).toBe('Speaker 1: one two\nSpeaker 2: reply\nSpeaker 1: three');
  });

  it('a single distinct channel WITH a full role map still joins UNPREFIXED (voicemail rides the role-stamped bridge item)', () => {
    // REACHABILITY (verified): a platform voicemail is captured by <Record> on the
    // MISSED inbound founder-bridge call and RIDES that same call item - which the
    // inbound <Dial> site stamped { "1":"client","2":"staff" } at ring time. So the
    // item DOES carry a roles map, but the recording is single-channel (the caller
    // only). Role prefixing requires 2+ distinct channels, so this stays unprefixed
    // (the caller is the client by construction, spec 4; T3 maps it to 'client').
    const sentences: ViSentence[] = [
      { text: 'please call me back', mediaChannel: 1 },
      { text: 'it is about the unit', mediaChannel: 1 },
    ];
    const roles: ChannelRoles = { '1': 'client', '2': 'staff' };
    expect(joinViSentences(sentences, roles)).toBe('please call me back it is about the unit');
  });
});
