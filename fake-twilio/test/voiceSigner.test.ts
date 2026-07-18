import { describe, expect, it } from 'vitest';
import twilio from 'twilio';
import { createHash } from 'node:crypto';
import { signTwilioWebhook, signTwilioJsonWebhook } from '../src/engine/signer.js';
import { buildInboundVoiceParams, buildWhisperGateParams, buildDialStatusParams, buildRecordingParams } from '../src/engine/signer.js';

const TOKEN = 'shared-secret-token';
function accepts(url: string, params: Record<string,string>) {
  return twilio.validateRequest(TOKEN, signTwilioWebhook({ authToken: TOKEN, url, params }), url, params);
}

describe('voice signer builders', () => {
  it('inbound voice params validate', () => {
    const p = buildInboundVoiceParams({ callSid: 'CA1', from: '+15550100001', to: '+15550199001' });
    expect(p).toMatchObject({ CallSid: 'CA1', From: '+15550100001', To: '+15550199001', CallStatus: 'ringing' });
    expect(accepts('http://localhost:5173/webhooks/twilio/voice', p)).toBe(true);
  });
  it('whisper-gate Digits validate', () => {
    const p = buildWhisperGateParams({ callSid: 'CA1', digits: '1' });
    expect(p['Digits']).toBe('1');
    expect(accepts('http://localhost:5173/webhooks/twilio/voice/whisper-gate?leg=founder', p)).toBe(true);
  });
  it('dial-status summary params validate', () => {
    const p = buildDialStatusParams({ callSid: 'CA1', dialCallStatus: 'completed', dialCallDuration: 42 });
    expect(p).toMatchObject({ CallSid: 'CA1', DialCallStatus: 'completed', DialCallDuration: '42' });
    expect(accepts('http://localhost:5173/webhooks/twilio/voice/status', p)).toBe(true);
  });
  it('recording params validate', () => {
    const p = buildRecordingParams({ callSid: 'CA1', recordingSid: 'RE1', recordingUrl: 'http://localhost:8889/recordings/CA1/RE1.mp3', durationSec: 12 });
    expect(p).toMatchObject({ CallSid: 'CA1', RecordingSid: 'RE1', RecordingStatus: 'completed' });
    expect(accepts('http://localhost:5173/webhooks/twilio/voice/recording', p)).toBe(true);
  });
});

// The Voice Intelligence completion webhook is JSON-bodied and signed with the
// bodySHA256 scheme (a `?bodySHA256=<sha256hex(rawBody)>` query param + an
// X-Twilio-Signature over the full URL with NO form params). The fake's hand-rolled
// signer must produce exactly what the app's twilio.validateRequestWithBody accepts.
describe('signTwilioJsonWebhook (VI webhook, bodySHA256 scheme)', () => {
  it('produces a signature validateRequestWithBody accepts, and a tampered body is rejected', () => {
    const body = JSON.stringify({ transcript_sid: 'GTfake1', status: 'completed' });
    const sha = createHash('sha256').update(body, 'utf8').digest('hex');
    const url = `http://localhost:5173/webhooks/twilio/voice/intelligence?bodySHA256=${sha}`;
    const sig = signTwilioJsonWebhook({ authToken: TOKEN, url });
    expect(twilio.validateRequestWithBody(TOKEN, sig, url, body)).toBe(true);
    // A body that no longer matches the bodySHA256 param must be rejected.
    expect(twilio.validateRequestWithBody(TOKEN, sig, url, `${body} tampered`)).toBe(false);
  });
  it('is base64(HMAC-SHA1(token, url)) with no params (same as signTwilioWebhook with empty params)', () => {
    const url = 'http://localhost:5173/webhooks/twilio/voice/intelligence?bodySHA256=abc';
    expect(signTwilioJsonWebhook({ authToken: TOKEN, url })).toBe(
      signTwilioWebhook({ authToken: TOKEN, url, params: {} }),
    );
  });
});
