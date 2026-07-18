// app/test/configVoiceIntelligence.test.ts
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/lib/config.js';

const base = { CF_ORIGIN_SECRET: 's', NODE_ENV: 'development' };

describe('voice intelligence config', () => {
  it('twilioViServiceSid is undefined when unset and read when set', () => {
    expect(loadConfig({ ...base }).twilioViServiceSid).toBeUndefined();
    expect(loadConfig({ ...base, TWILIO_VI_SERVICE_SID: 'GAxxxxfake' }).twilioViServiceSid).toBe('GAxxxxfake');
  });

  it('twilioViServiceSid trims a blank value to undefined (feature OFF)', () => {
    expect(loadConfig({ ...base, TWILIO_VI_SERVICE_SID: '   ' }).twilioViServiceSid).toBeUndefined();
  });

  it('voiceTranscriptReconcileSeconds defaults to 600 and parses an override', () => {
    expect(loadConfig({ ...base }).voiceTranscriptReconcileSeconds).toBe(600);
    expect(loadConfig({ ...base, VOICE_TRANSCRIPT_RECONCILE_SECONDS: '5' }).voiceTranscriptReconcileSeconds).toBe(5);
  });
});
