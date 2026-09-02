import { describe, expect, it } from 'vitest';

import {
  normalizeTwilioTransportEvidence,
  type TwilioTransportEvidenceInput,
} from '../src/adapters/twilioMessageTransport.js';

const SMS_SID = `SM${'a'.repeat(32)}`;
const MMS_SID = `MM${'b'.repeat(32)}`;

function normalize(input: Partial<TwilioTransportEvidenceInput>) {
  return normalizeTwilioTransportEvidence({
    direction: 'outbound',
    authenticatedProviderTraffic: true,
    ...input,
  });
}

describe('Twilio transport evidence normalization', () => {
  it.each([
    [
      'RCS From',
      { from: 'rcs:sender-id' },
      { kind: 'observed', transport: 'rcs', source: 'from' },
    ],
    [
      'RCS ChannelMetadata',
      { direction: 'inbound', channelMetadata: '{"type":"rcs"}', from: '+16175550100' },
      { kind: 'observed', transport: 'rcs', source: 'channel-metadata' },
    ],
    [
      'RCS ChannelPrefix without From',
      { channelPrefix: 'rcs' },
      { kind: 'observed', transport: 'rcs', source: 'channel-prefix' },
    ],
    [
      'RCS ChannelPrefix with channel-addressed From',
      { channelPrefix: 'rcs', from: 'rcs:sender-id' },
      { kind: 'observed', transport: 'rcs', source: 'from' },
    ],
    [
      'inbound SMS SID routed to E.164 To',
      { direction: 'inbound', messageSid: SMS_SID, to: '+16175550100' },
      { kind: 'observed', transport: 'sms', source: 'message-sid' },
    ],
    [
      'inbound MMS SID routed to E.164 To',
      { direction: 'inbound', messageSid: MMS_SID, to: '+16175550100' },
      { kind: 'observed', transport: 'mms', source: 'message-sid' },
    ],
    [
      'outbound SMS request with MMS SID',
      { requestedTransport: 'sms', messageSid: MMS_SID },
      { kind: 'observed', transport: 'mms', source: 'message-sid' },
    ],
    [
      'outbound MMS request with SMS SID',
      { requestedTransport: 'mms', messageSid: SMS_SID },
      { kind: 'observed', transport: 'sms', source: 'message-sid' },
    ],
    [
      'RCS fallback to SMS with E.164 From',
      { requestedTransport: 'rcs', messageSid: SMS_SID, from: '+16175550100' },
      { kind: 'observed', transport: 'sms', source: 'message-sid' },
    ],
    [
      'RCS fallback to MMS with E.164 From',
      { requestedTransport: 'rcs', messageSid: MMS_SID, from: '+16175550100' },
      { kind: 'observed', transport: 'mms', source: 'message-sid' },
    ],
  ] as const)('observes %s', (_name, input, expected) => {
    expect(normalize(input)).toEqual(expected);
  });

  it('gives explicit RCS evidence precedence over an SMS SID', () => {
    expect(
      normalize({
        direction: 'inbound',
        messageSid: SMS_SID,
        to: '+16175550100',
        channelMetadata: '{"type":"rcs"}',
      }),
    ).toEqual({ kind: 'observed', transport: 'rcs', source: 'channel-metadata' });
  });

  it.each([
    ['RCS ChannelPrefix with E.164 From', { channelPrefix: 'rcs', from: '+16175550100' }],
    ['malformed ChannelMetadata', { channelMetadata: '{bad-json' }],
    ['unknown ChannelPrefix', { channelPrefix: 'whatsapp', from: 'whatsapp:sender' }],
    ['contradictory rich-channel facts', { from: 'rcs:sender', channelPrefix: 'whatsapp' }],
    ['inbound SID with invalid To', { direction: 'inbound', messageSid: SMS_SID, to: '16175550100' }],
    ['RCS fallback SID with invalid From', { requestedTransport: 'rcs', messageSid: MMS_SID, from: '16175550100' }],
    ['provider-shaped unknown SID', { requestedTransport: 'sms', messageSid: `ZZ${'c'.repeat(32)}` }],
  ] as const)('returns safe conflict data for %s', (_name, input) => {
    const result = normalize(input);

    expect(result.kind).toBe('conflict');
    if (result.kind === 'conflict') {
      expect(JSON.stringify(result.safeFacts)).not.toContain('sender');
      expect(JSON.stringify(result.safeFacts)).not.toContain('16175550100');
    }
  });

  it.each([
    [
      'authenticated provider traffic',
      true,
      {
        kind: 'conflict',
        source: 'unknown-rich-channel-evidence',
        safeFacts: { sidPrefix: 'SM' },
      },
    ],
    [
      'unauthenticated fixture traffic',
      false,
      { kind: 'missing', source: 'unauthenticated-provider-evidence' },
    ],
  ] as const)('handles incomplete ChannelMetadata for %s', (_name, authenticatedProviderTraffic, expected) => {
    expect(
      normalize({
        direction: 'inbound',
        authenticatedProviderTraffic,
        messageSid: SMS_SID,
        to: '+16175550100',
        channelMetadata: '{}',
      }),
    ).toEqual(expected);
  });

  it('limits safe facts to provider prefixes and channel schemes', () => {
    expect(
      normalize({
        requestedTransport: 'rcs',
        messageSid: `ZZ${'c'.repeat(32)}`,
        from: 'whatsapp:private-address',
        channelPrefix: 'whatsapp:private-address',
      }),
    ).toEqual({
      kind: 'conflict',
      source: 'unknown-rich-channel-evidence',
      safeFacts: {
        sidPrefix: 'ZZ',
        fromScheme: 'whatsapp',
        channelScheme: 'whatsapp',
      },
    });
  });

  it.each([
    ['RCS request with SID alone', { requestedTransport: 'rcs', messageSid: SMS_SID }],
    ['outbound SID without stored request', { messageSid: SMS_SID, from: '+16175550100' }],
    ['fixture SID', { requestedTransport: 'sms', messageSid: 'dev-message-1' }],
    ['console fixture SID', { requestedTransport: 'sms', messageSid: 'SMconsole-123' }],
    ['empty evidence', {}],
  ] as const)('keeps %s missing', (_name, input) => {
    expect(normalize(input).kind).toBe('missing');
  });

  it('suppresses warning eligibility for unauthenticated traffic', () => {
    expect(
      normalize({
        authenticatedProviderTraffic: false,
        channelPrefix: 'rcs',
        from: '+16175550100',
      }),
    ).toEqual({ kind: 'missing', source: 'unauthenticated-provider-evidence' });
  });
});
