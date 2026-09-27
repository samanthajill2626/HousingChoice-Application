// app/test/twilioHttpClient.test.ts
import { describe, expect, it, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { Socket } from 'node:net';
import twilio from 'twilio';
import { createRedirectingHttpClient } from '../src/adapters/twilioHttpClient.js';

let server: Server | undefined;
afterEach(() => server?.close());

async function startCapture(): Promise<{ url: string; lastPath: () => string; lastBody: () => string }> {
  let lastPath = '';
  let lastBody = '';
  server = createServer((req, res) => {
    lastPath = req.url ?? '';
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => {
      lastBody = Buffer.concat(chunks).toString('utf8');
      res.setHeader('content-type', 'application/json');
      res.statusCode = 201;
      res.end(
        JSON.stringify({
          sid: 'SMfake12345',
          status: 'queued',
          date_created: 'Sun, 15 Jun 2026 14:00:00 +0000',
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, resolve));
  const addr = server!.address();
  if (addr === null || typeof addr === 'string') throw new Error('no port');
  return { url: `http://127.0.0.1:${addr.port}`, lastPath: () => lastPath, lastBody: () => lastBody };
}

describe('createRedirectingHttpClient', () => {
  it('routes messages.create to the fake host and parses the response', async () => {
    const capture = await startCapture();
    const client = twilio('SKtest', 'secrettest', {
      accountSid: 'ACtest',
      httpClient: createRedirectingHttpClient({ baseUrl: capture.url }),
    });

    const msg = await client.messages.create({
      to: '+15550100001',
      from: '+15550009999',
      body: 'hello from the real SDK',
    });

    expect(msg.sid).toBe('SMfake12345');
    expect(msg.status).toBe('queued');
    // The SDK built the canonical Messages path; our client rewrote only the host.
    expect(capture.lastPath()).toContain('/2010-04-01/Accounts/ACtest/Messages.json');
    expect(capture.lastBody()).toContain('To=%2B15550100001');
    expect(capture.lastBody()).toContain('Body=hello');
  });
});

// Spec D8a pins the Twilio request timeout to the send-claim TTL. twilio()
// applies its `timeout` option only to the default client it builds, never to
// a passed httpClient, so this client must take the timeout itself (SOR build
// spike Q5: unpinned, a stalled lane request ran the SDK's full 30 s).
describe('createRedirectingHttpClient request timeout', () => {
  it('takes its request timeout from opts.timeout, defaulting to the SDK 30000', () => {
    expect(createRedirectingHttpClient({ baseUrl: 'http://127.0.0.1:1', timeout: 1234 }).defaultTimeout).toBe(1234);
    expect(createRedirectingHttpClient({ baseUrl: 'http://127.0.0.1:1' }).defaultTimeout).toBe(30000);
  });

  it('a stalled request rejects with ECONNABORTED at the passed timeout, not the SDK default', async () => {
    const sockets = new Set<Socket>();
    // Accepts every request and never answers it.
    const stall = createServer(() => {});
    stall.on('connection', (socket) => {
      sockets.add(socket);
    });
    await new Promise<void>((resolve) => stall.listen(0, '127.0.0.1', resolve));
    const addr = stall.address();
    if (addr === null || typeof addr === 'string') throw new Error('no port');
    try {
      const client = twilio('SKtest', 'secrettest', {
        accountSid: 'ACtest',
        httpClient: createRedirectingHttpClient({ baseUrl: `http://127.0.0.1:${addr.port}`, timeout: 200 }),
      });
      const started = Date.now();
      const failure = await client.messages
        .create({ to: '+15550100001', from: '+15550009999', body: 'stall' })
        .then(
          () => undefined,
          (err: unknown) => err,
        );
      const elapsed = Date.now() - started;
      // The SDK's own timeout arrives as ECONNABORTED (never ETIMEDOUT).
      expect(failure).toMatchObject({ code: 'ECONNABORTED' });
      expect(elapsed).toBeLessThan(2000);
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => stall.close(() => resolve()));
    }
  });
});
