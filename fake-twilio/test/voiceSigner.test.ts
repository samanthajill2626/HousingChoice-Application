import { describe, expect, it } from 'vitest';
import twilio from 'twilio';
import { signTwilioWebhook } from '../src/engine/signer.js';
import { buildInboundVoiceParams, buildWhisperGateParams, buildDialStatusParams, buildRecordingParams, buildTranscriptionParams } from '../src/engine/signer.js';

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
  it('transcription params validate', () => {
    const p = buildTranscriptionParams({ callSid: 'CA1', transcript: 'hello there' });
    expect(p).toMatchObject({ CallSid: 'CA1', TranscriptionText: 'hello there' });
    expect(accepts('http://localhost:5173/webhooks/twilio/voice/transcription', p)).toBe(true);
  });
});
