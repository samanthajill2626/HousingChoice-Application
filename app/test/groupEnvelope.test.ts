import { describe, expect, it } from 'vitest';

import {
  hasGroupEnvelope,
  isMissingEnvelopeGroupShape,
  parseOtherRecipients,
} from '../src/services/groupEnvelope.js';

describe('parseOtherRecipients (group-texting T3.1)', () => {
  it('is empty for an ordinary 1:1 inbound with no envelope', () => {
    expect(parseOtherRecipients({ From: '+15550100001', To: '+15550009999' })).toEqual([]);
    expect(hasGroupEnvelope({ From: '+15550100001' })).toBe(false);
  });

  it('reads the indexed OtherRecipients0..N form in index order', () => {
    expect(
      parseOtherRecipients({
        OtherRecipients0: '+15550100002',
        OtherRecipients1: '+15550100003',
        OtherRecipients2: '+15550100004',
      }),
    ).toEqual(['+15550100002', '+15550100003', '+15550100004']);
  });

  it('tolerates GAPS in the index sequence instead of stopping at the first hole', () => {
    expect(
      parseOtherRecipients({
        OtherRecipients0: '+15550100002',
        OtherRecipients3: '+15550100005',
        OtherRecipients7: '+15550100009',
      }),
    ).toEqual(['+15550100002', '+15550100005', '+15550100009']);
  });

  it('reads a single UNINDEXED OtherRecipients param', () => {
    expect(parseOtherRecipients({ OtherRecipients: '+15550100002' })).toEqual(['+15550100002']);
  });

  it('reads the unindexed and indexed forms together without losing either', () => {
    expect(
      parseOtherRecipients({
        OtherRecipients: '+15550100002',
        OtherRecipients0: '+15550100003',
      }),
    ).toEqual(['+15550100002', '+15550100003']);
  });

  it('accepts a REPEATED unindexed key (express hands back a string[], not a string)', () => {
    // `extended: false` urlencoded parsing yields an array for a repeated key -
    // the WebhookParams string type would be lying, so the parser guards it.
    const params = { OtherRecipients: ['+15550100002', '+15550100003'] } as unknown as Record<
      string,
      string | undefined
    >;
    expect(parseOtherRecipients(params)).toEqual(['+15550100002', '+15550100003']);
  });

  it('skips empty and non-string values rather than emitting blanks', () => {
    const params = {
      OtherRecipients0: '',
      OtherRecipients1: '+15550100003',
      OtherRecipients2: undefined,
    } as Record<string, string | undefined>;
    expect(parseOtherRecipients(params)).toEqual(['+15550100003']);
  });

  it('trims surrounding whitespace on each entry', () => {
    expect(parseOtherRecipients({ OtherRecipients0: '  +15550100002  ' })).toEqual([
      '+15550100002',
    ]);
  });

  it('reads high indexes up to the cap (a 9-recipient carrier group and beyond)', () => {
    const params: Record<string, string> = {};
    for (let i = 0; i < 9; i++) params[`OtherRecipients${i}`] = `+1555010000${i}`;
    expect(parseOtherRecipients(params)).toHaveLength(9);
  });

  it('reports an envelope as present as soon as ONE recipient parses', () => {
    expect(hasGroupEnvelope({ OtherRecipients0: '+15550100002' })).toBe(true);
    expect(hasGroupEnvelope({ OtherRecipients0: '   ' })).toBe(false);
  });
});

describe('isMissingEnvelopeGroupShape (group-texting T3.7 tripwire)', () => {
  it('is true for an MM-prefixed sid with NumMedia=0 and no envelope', () => {
    expect(isMissingEnvelopeGroupShape('MM123', { NumMedia: '0' })).toBe(true);
  });

  it('is true when NumMedia is absent entirely (no media, MM shape)', () => {
    expect(isMissingEnvelopeGroupShape('MM123', {})).toBe(true);
  });

  it('is false for an SM-prefixed sid (an ordinary 1:1 SMS)', () => {
    expect(isMissingEnvelopeGroupShape('SM123', { NumMedia: '0' })).toBe(false);
  });

  it('is false when media is actually attached (a real MMS)', () => {
    expect(isMissingEnvelopeGroupShape('MM123', { NumMedia: '1' })).toBe(false);
  });

  it('is false when the envelope IS present (that inbound is handled as a group)', () => {
    expect(
      isMissingEnvelopeGroupShape('MM123', { NumMedia: '0', OtherRecipients0: '+15550100002' }),
    ).toBe(false);
  });
});
