// fake-twilio/test/signer.test.ts
import { describe, expect, it } from 'vitest';
import twilio from 'twilio';
import { signTwilioWebhook, buildInboundSmsParams, buildStatusParams } from '../src/engine/signer.js';

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

  it('builds status params with optional ErrorCode', () => {
    const p = buildStatusParams({ messageSid: 'SMout1', status: 'failed', errorCode: '30005' });
    expect(p).toMatchObject({ MessageSid: 'SMout1', MessageStatus: 'failed', ErrorCode: '30005' });
    const ok = buildStatusParams({ messageSid: 'SMout1', status: 'delivered' });
    expect(ok['ErrorCode']).toBeUndefined();
  });
});
