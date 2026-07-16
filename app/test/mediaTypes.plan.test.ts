import { describe, it, expect } from 'vitest';
import {
  TWILIO_DELIVERABLE_MMS_TYPES,
  isTwilioDeliverableType,
  planMmsMedia,
  INLINE_MEDIA_TYPES,
} from '../src/lib/mediaTypes.js';
import { PASSTHROUGH_MAX_BYTES } from '../src/lib/outboundMediaLimits.js';

describe('Twilio deliverable registry', () => {
  it('is exactly jpeg/png/gif', () => {
    expect([...TWILIO_DELIVERABLE_MMS_TYPES].sort()).toEqual(['image/gif', 'image/jpeg', 'image/png']);
  });
  it('isTwilioDeliverableType is case-insensitive and rejects webp/pdf', () => {
    expect(isTwilioDeliverableType('IMAGE/JPEG')).toBe(true);
    expect(isTwilioDeliverableType('image/webp')).toBe(false);
    expect(isTwilioDeliverableType('application/pdf')).toBe(false);
    expect(isTwilioDeliverableType(undefined)).toBe(false);
  });
});

describe('planMmsMedia', () => {
  const small = PASSTHROUGH_MAX_BYTES - 1;
  const big = PASSTHROUGH_MAX_BYTES + 1;
  it('pdf -> transcode-pdf', () => expect(planMmsMedia('application/pdf', small)).toBe('transcode-pdf'));
  it('gif -> deliver at any size', () => {
    expect(planMmsMedia('image/gif', small)).toBe('deliver');
    expect(planMmsMedia('image/gif', big)).toBe('deliver');
  });
  it('small jpeg/png -> deliver', () => {
    expect(planMmsMedia('image/jpeg', small)).toBe('deliver');
    expect(planMmsMedia('image/png', small)).toBe('deliver');
  });
  it('oversized jpeg/png -> transcode-image', () => {
    expect(planMmsMedia('image/jpeg', big)).toBe('transcode-image');
    expect(planMmsMedia('image/png', big)).toBe('transcode-image');
  });
  it('webp -> transcode-image at any size', () => {
    expect(planMmsMedia('image/webp', small)).toBe('transcode-image');
    expect(planMmsMedia('image/webp', big)).toBe('transcode-image');
  });
  it('GUARDRAIL: every uploadable type maps to a non-reject plan', () => {
    for (const t of INLINE_MEDIA_TYPES) {
      expect(planMmsMedia(t, small)).not.toBe('reject');
    }
  });
});
