import { describe, expect, it } from 'vitest';
import { interpretTwiml } from '../src/engine/twimlInterpreter.js';

const MASKED = `<?xml version="1.0" encoding="UTF-8"?><Response><Dial callerId="+15550199001" record="do-not-record" answerOnBridge="true" action="https://app/webhooks/twilio/voice/status" method="POST"><Number url="https://app/webhooks/twilio/voice/whisper?callerLabel=Tenant&parentCallSid=CA1" statusCallback="https://app/webhooks/twilio/voice/status" statusCallbackEvent="ringing">+15550100002</Number></Dial></Response>`;
const FOUNDER = `<?xml version="1.0" encoding="UTF-8"?><Response><Pause length="2"/><Dial callerId="+15550009999" record="record-from-answer-dual" recordingStatusCallback="https://app/webhooks/twilio/voice/recording" answerOnBridge="true" action="https://app/webhooks/twilio/voice/status"><Number url="https://app/webhooks/twilio/voice/whisper?leg=founder&parentCallSid=CA2">+15551230000</Number></Dial></Response>`;
const WHISPER = `<?xml version="1.0" encoding="UTF-8"?><Response><Gather numDigits="1" timeout="8" action="https://app/webhooks/twilio/voice/whisper-gate" method="POST"><Say>Press 1 to accept, or press 0 to reach the team.</Say></Gather><Hangup/></Response>`;
const GATE_ACCEPT = `<?xml version="1.0" encoding="UTF-8"?><Response><Pause length="1"/></Response>`;
const GATE_HANGUP = `<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`;

describe('interpretTwiml', () => {
  it('parses a masked Dial with a Number+whisper leg', () => {
    const plan = interpretTwiml(MASKED);
    expect(plan.kind).toBe('dial');
    if (plan.kind !== 'dial') throw new Error('x');
    expect(plan.callerId).toBe('+15550199001');
    expect(plan.record).toBe('do-not-record');
    expect(plan.actionUrl).toContain('/voice/status');
    expect(plan.recordingStatusCallback).toBeUndefined();
    expect(plan.numbers).toHaveLength(1);
    expect(plan.numbers[0]).toMatchObject({ phone: '+15550100002' });
    expect(plan.numbers[0]?.whisperUrl).toContain('/voice/whisper?');
  });
  it('parses a founder Pause+Dial with recording callback', () => {
    const plan = interpretTwiml(FOUNDER);
    if (plan.kind !== 'dial') throw new Error('x');
    expect(plan.record).toBe('record-from-answer-dual');
    expect(plan.recordingStatusCallback).toContain('/voice/recording');
    expect(plan.numbers[0]?.whisperUrl).toContain('leg=founder');
  });
  it('parses a whisper Gather', () => {
    const plan = interpretTwiml(WHISPER);
    expect(plan.kind).toBe('gather');
    if (plan.kind !== 'gather') throw new Error('x');
    expect(plan.actionUrl).toContain('/voice/whisper-gate');
    expect(plan.numDigits).toBe(1);
    expect(plan.sayContainsPress0).toBe(true);
  });
  it('classifies gate accept (Pause) vs hangup', () => {
    expect(interpretTwiml(GATE_ACCEPT).kind).toBe('pause');
    expect(interpretTwiml(GATE_HANGUP).kind).toBe('hangup');
  });
  it('parses a group Dial with two Number legs (each with its own whisper + statusCallback)', () => {
    const group = `<Response><Dial callerId="+15550199001" record="do-not-record" action="https://app/webhooks/twilio/voice/status"><Number url="https://app/webhooks/twilio/voice/whisper?leg=a" statusCallback="https://app/webhooks/twilio/voice/status">+15550100002</Number><Number url="https://app/webhooks/twilio/voice/whisper?leg=b" statusCallback="https://app/webhooks/twilio/voice/status">+15550100003</Number></Dial></Response>`;
    const plan = interpretTwiml(group);
    expect(plan.kind).toBe('dial');
    if (plan.kind !== 'dial') throw new Error('x');
    expect(plan.numbers).toHaveLength(2);
    expect(plan.numbers[0]?.phone).toBe('+15550100002');
    expect(plan.numbers[0]?.whisperUrl).toContain('leg=a');
    expect(plan.numbers[0]?.statusCallback).toContain('/voice/status');
    expect(plan.numbers[1]?.phone).toBe('+15550100003');
    expect(plan.numbers[1]?.whisperUrl).toContain('leg=b');
    expect(plan.numbers[1]?.statusCallback).toContain('/voice/status');
  });
  it('detects press-0 in a Gather whose Say carries attributes', () => {
    const xml = `<Response><Gather numDigits="1" timeout="8" action="https://app/webhooks/twilio/voice/whisper-gate"><Say voice="alice">Press 1 to accept, or press 0 to reach the team.</Say></Gather><Hangup/></Response>`;
    const plan = interpretTwiml(xml);
    expect(plan.kind).toBe('gather');
    if (plan.kind !== 'gather') throw new Error('x');
    expect(plan.sayContainsPress0).toBe(true);
  });
  it('parses a press-0 team Dial (no whisper) as dial', () => {
    const teamDial = `<Response><Dial callerId="+15550009999"><Number>+15550009999</Number></Dial></Response>`;
    const plan = interpretTwiml(teamDial);
    if (plan.kind !== 'dial') throw new Error('x');
    expect(plan.numbers[0]?.whisperUrl).toBeUndefined();
  });
  it('parses a Say+Record+Say+Hangup voicemail response into a record plan (self-closing <Record/> wins over the trailing Hangup)', () => {
    // The EXACT byte shape the app's missed inbound founder-bridge /status branch emits
    // (slice 3 report): self-closing <Record/> with camelCase attrs, wrapped by Say(prompt)
    // + Say(thanks) + Hangup. Record MUST be detected before the Hangup/Say fallbacks.
    const VOICEMAIL = `<?xml version="1.0" encoding="UTF-8"?><Response><Say>Sorry we missed your call.</Say><Record maxLength="120" playBeep="true" action="https://app/webhooks/twilio/voice/voicemail-done" recordingStatusCallback="https://app/webhooks/twilio/voice/recording" recordingStatusCallbackEvent="completed"/><Say>Thank you.</Say><Hangup/></Response>`;
    const plan = interpretTwiml(VOICEMAIL);
    expect(plan.kind).toBe('record');
    if (plan.kind !== 'record') throw new Error('x');
    expect(plan.maxLength).toBe(120);
    expect(plan.playBeep).toBe(true);
    expect(plan.actionUrl).toContain('/voice/voicemail-done');
    expect(plan.recordingStatusCallback).toContain('/voice/recording');
  });
});
