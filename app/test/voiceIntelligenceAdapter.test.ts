import { describe, it, expect, vi } from 'vitest';
import { TwilioMessagingDriver, ConsoleMessagingDriver } from '../src/adapters/messaging.js';

// Minimal driver deps: with `client` injected, the account/key creds are never
// used to build a real twilio client - they only satisfy the ctor shape.
const BASE_DEPS = {
  accountSid: 'ACtest',
  apiKeySid: 'SKtest',
  apiKeySecret: 'secret',
  messagingServiceSid: 'MGtest',
} as const;

// Shapes match twilio v6 intelligence.v2.transcripts exactly (worklist SDK FACTS):
// create({ serviceSid, channel, customerKey }) -> instance.sid;
// transcripts(sid).fetch() -> instance {.sid,.status,.customerKey};
// transcripts(sid).sentences.list() -> [{ transcript, mediaChannel }].
function fakeTwilioClient() {
  const create = vi.fn().mockResolvedValue({ sid: 'GTfake1' });
  const fetch = vi.fn().mockResolvedValue({ sid: 'GTfake1', status: 'completed', customerKey: 'CAtest1' });
  const list = vi.fn().mockResolvedValue([
    { transcript: 'hello there', mediaChannel: 1 },
    { transcript: 'hi back', mediaChannel: 2 },
  ]);
  const transcripts = Object.assign((_sid: string) => ({ fetch, sentences: { list } }), { create });
  return { client: { intelligence: { v2: { transcripts } } }, create, fetch, list };
}

describe('VI adapter methods (TwilioMessagingDriver)', () => {
  it('createViTranscript posts serviceSid + recording source + customerKey and returns the sid', async () => {
    const f = fakeTwilioClient();
    const driver = new TwilioMessagingDriver({ ...BASE_DEPS, client: f.client as never });
    const out = await driver.createViTranscript({ serviceSid: 'GAsvc', recordingSid: 'REfake1', customerKey: 'CAtest1' });
    expect(out).toEqual({ transcriptSid: 'GTfake1' });
    expect(f.create).toHaveBeenCalledWith({
      serviceSid: 'GAsvc',
      channel: { media_properties: { source_sid: 'REfake1' } },
      customerKey: 'CAtest1',
    });
  });

  it('fetchViTranscript maps sid + status + customerKey', async () => {
    const f = fakeTwilioClient();
    const driver = new TwilioMessagingDriver({ ...BASE_DEPS, client: f.client as never });
    expect(await driver.fetchViTranscript('GTfake1')).toEqual({
      transcriptSid: 'GTfake1',
      status: 'completed',
      customerKey: 'CAtest1',
    });
  });

  it('listViSentences maps transcript text + mediaChannel', async () => {
    const f = fakeTwilioClient();
    const driver = new TwilioMessagingDriver({ ...BASE_DEPS, client: f.client as never });
    expect(await driver.listViSentences('GTfake1')).toEqual([
      { text: 'hello there', mediaChannel: 1 },
      { text: 'hi back', mediaChannel: 2 },
    ]);
  });
});

describe('VI adapter methods (ConsoleMessagingDriver)', () => {
  it('throws - the console driver is never used with VI configured', async () => {
    const driver = new ConsoleMessagingDriver();
    await expect(driver.createViTranscript({ serviceSid: 'GAsvc', recordingSid: 'REfake1', customerKey: 'CAtest1' })).rejects.toThrow(
      /voice intelligence unavailable/,
    );
    await expect(driver.fetchViTranscript('GTfake1')).rejects.toThrow(/voice intelligence unavailable/);
    await expect(driver.listViSentences('GTfake1')).rejects.toThrow(/voice intelligence unavailable/);
  });
});
