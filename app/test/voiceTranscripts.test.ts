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

  it('a single distinct channel with no map joins UNPREFIXED (voicemail: one caller, no dial => never role-stamped)', () => {
    // A voicemail recording has ONE media channel and is captured by <Record>, NOT
    // <Dial> - so no append site ever stamps transcript_channel_roles on it (the
    // dial sites are the only stampers; asserted in founderTriage/voiceOutbound).
    // A lone channel therefore stays unprefixed in the real flow.
    const sentences: ViSentence[] = [
      { text: 'please call me back', mediaChannel: 1 },
      { text: 'it is about the unit', mediaChannel: 1 },
    ];
    expect(joinViSentences(sentences)).toBe('please call me back\nit is about the unit');
  });
});
