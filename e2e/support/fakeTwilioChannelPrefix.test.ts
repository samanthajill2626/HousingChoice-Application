import { describe, expect, it } from 'vitest';
import { validateInboundChannelPrefix } from '../fixtures/fakeTwilio.js';

describe('direct inbound ChannelPrefix fixtures', () => {
  it.each([undefined, 'rcs'])('supports documented %s evidence', (channelPrefix) => {
    expect(validateInboundChannelPrefix(channelPrefix)).toBe(channelPrefix);
  });

  it.each(['sms', 'mms'])('rejects fabricated %s evidence', (channelPrefix) => {
    expect(() => validateInboundChannelPrefix(channelPrefix)).toThrow(/ChannelPrefix/);
  });
});
