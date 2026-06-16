import { describe, expect, it, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { TwilioMessagingDriver } from '../src/adapters/messaging.js';

let server: Server | undefined;
afterEach(() => server?.close());

async function startAudioHost(): Promise<{ origin: string; port: number }> {
  server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'audio/mpeg', 'content-length': '3' });
    res.end(Buffer.from([0x49, 0x44, 0x33]));
  });
  await new Promise<void>((r) => server!.listen(0, r));
  const addr = server!.address();
  if (addr === null || typeof addr === 'string') throw new Error('no port');
  return { origin: `http://127.0.0.1:${addr.port}`, port: addr.port };
}

function driver(apiBaseUrl?: string) {
  return new TwilioMessagingDriver({
    accountSid: 'ACx', apiKeySid: 'SKx', apiKeySecret: 'secret', messagingServiceSid: 'MGx',
    ...(apiBaseUrl !== undefined && { apiBaseUrl }),
    client: {} as never, // not used for media fetch (raw fetch)
  });
}

describe('media-fetch dev-override', () => {
  it('fetches a recording from the fake host when apiBaseUrl matches it', async () => {
    const { origin } = await startAudioHost();
    const stream = await driver(origin).getRecordingStream(`${origin}/recordings/CA1/RE1.mp3`);
    const chunks: Buffer[] = [];
    for await (const c of stream) chunks.push(c as Buffer);
    expect(Buffer.concat(chunks).length).toBe(3);
  });

  it('still REFUSES a non-allowed host even with apiBaseUrl set', async () => {
    const { origin } = await startAudioHost();
    await expect(driver(origin).getRecordingStream('http://evil.example/x.mp3')).rejects.toThrow(/host_not_allowed|refusing media/i);
  });

  it('without apiBaseUrl, only https api.twilio.com is allowed (http fake refused)', async () => {
    const { origin } = await startAudioHost();
    await expect(driver(undefined).getRecordingStream(`${origin}/x.mp3`)).rejects.toThrow(/host_not_allowed|refusing media/i);
  });
});
