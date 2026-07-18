import { describe, it, expect, beforeEach } from 'vitest';
import { createFakeWorld } from './helpers/twilioWebhookHarness.js';
// The suite runs against the harness fake messagesRepo, which mirrors the real
// repo's conditional-write semantics 1:1 (the contract mirror the routes/jobs
// rely on). The real repo's conditions are the same DynamoDB expressions; the
// route/job tests in later tasks exercise the real repo end to end.

describe('transcript_status + voicemail outcome conditional writes (fake contract)', () => {
  let world: ReturnType<typeof createFakeWorld>;
  beforeEach(() => {
    world = createFakeWorld();
  });

  function seedCall(over: Record<string, unknown> = {}): void {
    world.messages.push({
      conversationId: 'c1',
      tsMsgId: 'CAtest1',
      type: 'call',
      direction: 'inbound',
      provider_sid: 'CAtest1',
      delivery_status: 'delivered',
      masked: false,
      call_outcome: 'missed',
      ...over,
    } as never);
  }

  it('setTranscriptPending stamps once, false on repeat', async () => {
    seedCall();
    expect(await world.messagesRepo.setTranscriptPending('CAtest1')).toBe(true);
    expect(await world.messagesRepo.setTranscriptPending('CAtest1')).toBe(false);
    expect(world.messages[0]!.transcript_status).toBe('pending');
  });

  it('setTranscriptFailed only from pending; completed is terminal', async () => {
    seedCall();
    expect(await world.messagesRepo.setTranscriptFailed('CAtest1')).toBe(false); // not pending yet
    await world.messagesRepo.setTranscriptPending('CAtest1');
    expect(await world.messagesRepo.setTranscriptFailed('CAtest1')).toBe(true);
    // late text still completes (condition is on transcript, not status):
    expect(await world.messagesRepo.setCallTranscript('CAtest1', 'late text')).toBe(true);
    expect(world.messages[0]!.transcript_status).toBe('completed');
    expect(await world.messagesRepo.setTranscriptFailed('CAtest1')).toBe(false); // terminal
  });

  it('setCallTranscript stamps completed and never overwrites', async () => {
    seedCall();
    expect(await world.messagesRepo.setCallTranscript('CAtest1', 'first')).toBe(true);
    expect(world.messages[0]!.transcript_status).toBe('completed');
    expect(await world.messagesRepo.setCallTranscript('CAtest1', 'second')).toBe(false);
    expect(world.messages[0]!.transcript).toBe('first');
  });

  it('upgradeCallOutcomeToVoicemail only from missed, once', async () => {
    seedCall();
    expect(await world.messagesRepo.upgradeCallOutcomeToVoicemail('CAtest1')).toBe(true);
    expect(world.messages[0]!.call_outcome).toBe('voicemail');
    expect(await world.messagesRepo.upgradeCallOutcomeToVoicemail('CAtest1')).toBe(false);
  });

  it('upgrade refuses an answered call', async () => {
    seedCall({ call_outcome: 'answered' });
    expect(await world.messagesRepo.upgradeCallOutcomeToVoicemail('CAtest1')).toBe(false);
  });

  it('conditional writes on an unknown CallSid return false', async () => {
    expect(await world.messagesRepo.setTranscriptPending('CAnope')).toBe(false);
    expect(await world.messagesRepo.setTranscriptFailed('CAnope')).toBe(false);
    expect(await world.messagesRepo.upgradeCallOutcomeToVoicemail('CAnope')).toBe(false);
  });
});
