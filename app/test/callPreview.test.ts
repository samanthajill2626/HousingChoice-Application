import { describe, expect, it } from 'vitest';

import { callPreview, formatCallDuration } from '../src/lib/callPreview.js';

describe('formatCallDuration', () => {
  it('renders minutes + seconds, seconds-only under a minute, and nothing for absent/invalid', () => {
    expect(formatCallDuration(0)).toBe('0s');
    expect(formatCallDuration(42)).toBe('42s');
    expect(formatCallDuration(60)).toBe('1m 0s');
    expect(formatCallDuration(754)).toBe('12m 34s');
    expect(formatCallDuration(undefined)).toBeUndefined();
    expect(formatCallDuration(-1)).toBeUndefined();
    expect(formatCallDuration(Number.NaN)).toBeUndefined();
  });
});

describe('callPreview - the inbox preview line for a call row', () => {
  // Producers: the voice paths STORE the terminal / voicemail strings via
  // touchLastActivity; the inbox's deriveLatest DERIVES a preview from a
  // call-latest row at read time (which is where the ringing arm is reached -
  // during the ring, or forever after a caller-abandon). The in-progress arm is
  // reached only when a Dial in-progress summary beats the whisper gate.
  it('ringing: inbound "Incoming call", outbound "Outgoing call"', () => {
    expect(callPreview({ direction: 'inbound', callStatus: 'ringing' })).toBe('Incoming call');
    expect(callPreview({ direction: 'outbound', callStatus: 'ringing' })).toBe('Outgoing call');
  });

  it('in-progress: the bridge connected', () => {
    expect(callPreview({ direction: 'inbound', callStatus: 'in-progress' })).toBe('Call in progress');
    expect(callPreview({ direction: 'outbound', callStatus: 'in-progress' })).toBe('Outgoing call in progress');
  });

  it('terminal missed: inbound "Missed call", outbound "Outgoing call - no answer"', () => {
    expect(callPreview({ direction: 'inbound', callStatus: 'no-answer', callOutcome: 'missed' })).toBe('Missed call');
    expect(callPreview({ direction: 'inbound', callStatus: 'completed', callOutcome: 'missed' })).toBe('Missed call');
    expect(callPreview({ direction: 'outbound', callStatus: 'no-answer', callOutcome: 'missed' })).toBe(
      'Outgoing call - no answer',
    );
  });

  it('terminal answered: carries the talk time when known', () => {
    expect(
      callPreview({ direction: 'inbound', callStatus: 'completed', callOutcome: 'answered', callDuration: 754 }),
    ).toBe('Call - 12m 34s');
    expect(callPreview({ direction: 'inbound', callStatus: 'completed', callOutcome: 'answered' })).toBe('Call');
    expect(
      callPreview({ direction: 'outbound', callStatus: 'completed', callOutcome: 'answered', callDuration: 42 }),
    ).toBe('Outgoing call - 42s');
    expect(callPreview({ direction: 'outbound', callStatus: 'completed', callOutcome: 'answered' })).toBe(
      'Outgoing call',
    );
  });

  it('voicemail outcome wins over everything else', () => {
    expect(callPreview({ direction: 'inbound', callStatus: 'no-answer', callOutcome: 'voicemail' })).toBe('Voicemail');
  });

  it('a terminal status with no outcome falls back to the plain call label (never throws)', () => {
    expect(callPreview({ direction: 'inbound', callStatus: 'failed' })).toBe('Call');
    expect(callPreview({ direction: 'outbound', callStatus: 'canceled' })).toBe('Outgoing call');
  });
});
