// fake-twilio/test/signer.test.ts
import { describe, expect, it } from 'vitest';
import twilio from 'twilio';
import {
  signTwilioWebhook,
  buildInboundSmsParams,
  buildStatusParams,
  buildConversationsDeliveryParams,
  buildConversationsMessageAddedParams,
} from '../src/engine/signer.js';

const TOKEN = 'shared-secret-token';

describe('signTwilioWebhook', () => {
  it('produces a signature the app validator accepts (inbound SMS)', () => {
    const url = 'http://localhost:5173/webhooks/twilio/sms';
    const params = buildInboundSmsParams({
      messageSid: 'SMinbound1', from: '+15550100001', to: '+15550009999', body: 'hello',
    });
    const signature = signTwilioWebhook({ authToken: TOKEN, url, params });
    expect(twilio.validateRequest(TOKEN, signature, url, params)).toBe(true);
  });

  it('produces a signature the validator REJECTS when the body is tampered', () => {
    const url = 'http://localhost:5173/webhooks/twilio/sms';
    const params = buildInboundSmsParams({ messageSid: 'SMinbound1', from: '+15550100001', to: '+15550009999', body: 'hello' });
    const signature = signTwilioWebhook({ authToken: TOKEN, url, params });
    expect(twilio.validateRequest(TOKEN, signature, url, { ...params, Body: 'tampered' })).toBe(false);
  });

  it('encodes MMS media fields (NumMedia + MediaUrl{i})', () => {
    const params = buildInboundSmsParams({
      messageSid: 'MM1', from: '+15550100001', to: '+15550009999',
      mediaUrls: ['http://localhost:8889/media/cat.jpg'],
    });
    expect(params['NumMedia']).toBe('1');
    expect(params['MediaUrl0']).toBe('http://localhost:8889/media/cat.jpg');
  });

  it('infers MediaContentType from the URL extension (FIX 7)', () => {
    const params = buildInboundSmsParams({
      messageSid: 'MM2', from: '+15550100001', to: '+15550009999',
      mediaUrls: [
        'http://x/a.png',
        'http://x/b.gif',
        'http://x/c.webp',
        'http://x/d.jpeg',
        'http://x/e.pdf',
      ],
    });
    expect(params['MediaContentType0']).toBe('image/png');
    expect(params['MediaContentType1']).toBe('image/gif');
    expect(params['MediaContentType2']).toBe('image/webp');
    expect(params['MediaContentType3']).toBe('image/jpeg');
    expect(params['MediaContentType4']).toBe('application/pdf');
  });

  it('falls back to application/octet-stream for unknown extensions', () => {
    const params = buildInboundSmsParams({
      messageSid: 'MM3', from: '+15550100001', to: '+15550009999',
      mediaUrls: ['http://x/f.bin'],
    });
    expect(params['MediaContentType0']).toBe('application/octet-stream');
  });

  it('builds status params with optional ErrorCode', () => {
    const p = buildStatusParams({ messageSid: 'SMout1', status: 'failed', errorCode: '30005' });
    expect(p).toMatchObject({ MessageSid: 'SMout1', MessageStatus: 'failed', ErrorCode: '30005' });
    const ok = buildStatusParams({ messageSid: 'SMout1', status: 'delivered' });
    expect(ok['ErrorCode']).toBeUndefined();
  });

  it('carries only explicitly declared transport evidence through signed callback shapes', () => {
    const metadata = { type: 'rcs', sender: 'business-agent' };
    const inbound = buildInboundSmsParams({
      messageSid: `SM${'1'.repeat(32)}`,
      from: 'rcs:agent',
      to: '+15550009999',
      channelPrefix: 'rcs',
      channelMetadata: metadata,
    });
    expect(inbound).toMatchObject({
      ChannelPrefix: 'rcs',
      ChannelMetadata: JSON.stringify(metadata),
    });

    const status = buildStatusParams({
      messageSid: `MM${'2'.repeat(32)}`,
      status: 'delivered',
      from: '+15550009999',
      to: '+15550100001',
      channelMetadata: JSON.stringify(metadata),
    });
    expect(status).toMatchObject({
      From: '+15550009999',
      To: '+15550100001',
      ChannelMetadata: JSON.stringify(metadata),
    });
    expect(status['ChannelPrefix']).toBeUndefined();
  });

  it('does not fabricate SMS or MMS ChannelPrefix fields', () => {
    expect(buildInboundSmsParams({
      messageSid: `SM${'3'.repeat(32)}`,
      from: '+15550100001',
      to: '+15550009999',
    })['ChannelPrefix']).toBeUndefined();
    expect(buildStatusParams({
      messageSid: `MM${'4'.repeat(32)}`,
      status: 'sent',
      from: '+15550009999',
      to: '+15550100001',
    })['ChannelPrefix']).toBeUndefined();
    expect(() => buildInboundSmsParams({
      messageSid: `SM${'5'.repeat(32)}`,
      from: '+15550100001',
      to: '+15550009999',
      channelPrefix: 'sms',
    })).toThrow(/ChannelPrefix/);
  });

  // --- carrier-group envelope (group-texting spec 5.1) ---

  it('encodes the INDEXED OtherRecipients envelope', () => {
    const params = buildInboundSmsParams({
      messageSid: 'MMgroup1',
      from: '+15550100001',
      to: '+15550009999',
      body: 'hi both',
      otherRecipients: ['+15550100002', '+15550100003'],
    });
    expect(params['OtherRecipients0']).toBe('+15550100002');
    expect(params['OtherRecipients1']).toBe('+15550100003');
    expect(params['OtherRecipients']).toBeUndefined();
  });

  it('encodes the SINGLE bare-key envelope, and refuses to shorten a roster into it', () => {
    const params = buildInboundSmsParams({
      messageSid: 'MMgroup2',
      from: '+15550100001',
      to: '+15550009999',
      otherRecipients: ['+15550100002'],
      otherRecipientsShape: 'single',
    });
    expect(params['OtherRecipients']).toBe('+15550100002');
    // A short roster is a DIFFERENT conversationId - i.e. a forked thread. The
    // single shape cannot carry two addresses, so it refuses rather than drops.
    expect(() =>
      buildInboundSmsParams({
        messageSid: 'MMgroup3',
        from: '+15550100001',
        to: '+15550009999',
        otherRecipients: ['+15550100002', '+15550100003'],
        otherRecipientsShape: 'single',
      }),
    ).toThrow(/exactly one address/);
  });

  it('signs a group-envelope inbound the app validator accepts', () => {
    const url = 'http://localhost:5173/webhooks/twilio/sms';
    const params = buildInboundSmsParams({
      messageSid: 'MMgroup4',
      from: '+15550100001',
      to: '+15550009999',
      body: 'group hello',
      otherRecipients: ['+15550100002', '+15550100003'],
    });
    const signature = signTwilioWebhook({ authToken: TOKEN, url, params });
    expect(twilio.validateRequest(TOKEN, signature, url, params)).toBe(true);
  });

  // --- Conversations webhook params (spec 7/16, live-captured shapes) ---

  it('signs an onDeliveryUpdated the app validator accepts, with both join keys', () => {
    const url = 'http://localhost:5173/webhooks/twilio/conversations';
    const params = buildConversationsDeliveryParams({
      conversationSid: 'CHfake00000001',
      messageSid: 'IMfake00000002',
      participantSid: 'MBfake00000003',
      status: 'undelivered',
      errorCode: '21610',
      channelMessageSid: 'SMfake00000004',
    });
    expect(params['EventType']).toBe('onDeliveryUpdated');
    // `Status`, NOT `DeliveryStatus` - the live capture and the shipped route
    // both read this key, and getting it wrong would drop every receipt.
    expect(params['Status']).toBe('undelivered');
    expect(params['ParticipantSid']).toBe('MBfake00000003');
    expect(params['ChannelMessageSid']).toBe('SMfake00000004');
    const signature = signTwilioWebhook({ authToken: TOKEN, url, params });
    expect(twilio.validateRequest(TOKEN, signature, url, params)).toBe(true);
  });

  it('signs an onMessageAdded the app validator accepts, in both Source flavors', () => {
    const url = 'http://localhost:5173/webhooks/twilio/conversations';
    for (const source of ['SMS', 'API']) {
      const params = buildConversationsMessageAddedParams({
        conversationSid: 'CHfake00000001',
        messageSid: 'IMfake00000005',
        participantSid: 'MBfake00000003',
        author: '+15550100001',
        body: 'carrier-sourced',
        index: 1,
        source,
      });
      expect(params['EventType']).toBe('onMessageAdded');
      expect(params['Source']).toBe(source);
      const signature = signTwilioWebhook({ authToken: TOKEN, url, params });
      expect(twilio.validateRequest(TOKEN, signature, url, params)).toBe(true);
    }
  });
});
