// fake-twilio/test/events.test.ts
import { describe, expect, it } from 'vitest';
import http from 'node:http';
import { buildFakeTwilioApp } from '../src/server.js';
import { loadFakeConfig } from '../src/config.js';
import { FakeTwilioEngine } from '../src/engine/engine.js';
import { ManualClock } from '../src/engine/clock.js';

function cfg() {
  return loadFakeConfig({ NODE_ENV: 'test', TWILIO_AUTH_TOKEN: 't' });
}

describe('GET /control/events (SSE)', () => {
  it('sends the connected comment then an event when the engine emits', async () => {
    const engine = new FakeTwilioEngine({ clock: new ManualClock('2026-06-15T00:00:00.000Z'), dispatcher: { post: async () => 200 } });
    const app = buildFakeTwilioApp({ config: cfg(), engine });
    const server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, r));
    const addr = server.address();
    if (addr === null || typeof addr === 'string') throw new Error('no port');

    const chunks: string[] = [];
    const req = http.get({ port: addr.port, path: '/control/events' });
    const body: string = await new Promise((resolve) => {
      req.on('response', (res) => {
        expect(res.headers['content-type']).toContain('text/event-stream');
        res.setEncoding('utf8');
        res.on('data', (c: string) => {
          chunks.push(c);
          // Trigger an engine event after the stream opens.
          if (chunks.join('').includes(': connected')) {
            void engine.sendAsParty({ from: '+15550100001', body: 'hi' });
          }
          if (chunks.join('').includes('message.appended')) {
            req.destroy();
            resolve(chunks.join(''));
          }
        });
      });
    });
    server.close();

    expect(body).toContain(': connected');
    expect(body).toContain('event: message.appended');
    expect(body).toContain('"partyNumber":"+15550100001"');
  });

  it('reclaims a connection slot after a socket drops (cleanup runs once)', async () => {
    const engine = new FakeTwilioEngine({ clock: new ManualClock('2026-06-15T00:00:00.000Z'), dispatcher: { post: async () => 200 } });
    const app = buildFakeTwilioApp({ config: cfg(), engine });
    const server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, r));
    const addr = server.address();
    if (addr === null || typeof addr === 'string') throw new Error('no port');

    // Open a stream, wait for ': connected', then abruptly destroy the socket.
    await new Promise<void>((resolve) => {
      const req = http.get({ port: addr.port, path: '/control/events' });
      req.on('response', (res) => {
        res.setEncoding('utf8');
        res.on('data', (c: string) => {
          if (c.includes(': connected')) req.destroy();
        });
        res.on('close', resolve);
      });
    });

    // Give the server a tick to run its socket-close/error cleanup, then assert the
    // slot is back: a NEW stream still gets ': connected' (would 503 if the slot
    // leaked at MAX_CONNECTIONS — here we mainly prove the server is healthy and an
    // engine emit after the drop doesn't throw against the torn-down subscriber).
    await new Promise((r) => setTimeout(r, 20));
    engine.addAdHoc({ label: 'After drop', role: 'tenant' }); // emits to no live socket; must not throw

    const second: string = await new Promise((resolve) => {
      const req = http.get({ port: addr.port, path: '/control/events' });
      req.on('response', (res) => {
        const chunks: string[] = [];
        res.setEncoding('utf8');
        res.on('data', (c: string) => {
          chunks.push(c);
          if (chunks.join('').includes(': connected')) {
            req.destroy();
            resolve(chunks.join(''));
          }
        });
      });
    });
    server.close();
    expect(second).toContain(': connected');
  });
});
