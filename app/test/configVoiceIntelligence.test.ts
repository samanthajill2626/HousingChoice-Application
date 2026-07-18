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

  // Adjudication F2: the reconcile delay follows the file's NOT-fail-fast numeric
  // idiom (A2P_RATE_LIMIT_PER_SEC) - a non-finite or non-positive value falls back
  // to the 600s default (with a WARN) instead of riding into the enqueue math,
  // where a negative delay would fire every reconcile attempt immediately and
  // stamp transcript_status=failed before VI ever completes.
  it('voiceTranscriptReconcileSeconds falls back to 600 on an explicit "0" (a zero-delay reconcile is invalid)', () => {
    expect(loadConfig({ ...base, VOICE_TRANSCRIPT_RECONCILE_SECONDS: '0' }).voiceTranscriptReconcileSeconds).toBe(600);
  });

  it('voiceTranscriptReconcileSeconds falls back to 600 on a negative value', () => {
    expect(loadConfig({ ...base, VOICE_TRANSCRIPT_RECONCILE_SECONDS: '-5' }).voiceTranscriptReconcileSeconds).toBe(600);
  });

  it('voiceTranscriptReconcileSeconds falls back to 600 on a non-numeric value', () => {
    expect(loadConfig({ ...base, VOICE_TRANSCRIPT_RECONCILE_SECONDS: 'abc' }).voiceTranscriptReconcileSeconds).toBe(600);
  });

  it('voiceTranscriptReconcileSeconds accepts the tiny e2e lane value 2', () => {
    expect(loadConfig({ ...base, VOICE_TRANSCRIPT_RECONCILE_SECONDS: '2' }).voiceTranscriptReconcileSeconds).toBe(2);
  });
});
