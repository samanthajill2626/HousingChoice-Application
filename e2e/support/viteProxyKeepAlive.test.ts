// The dashboard dev server's proxy to the app must POOL its connections
// (dashboard/vite.config.ts, appProxy.agent). Without an agent, Vite's proxy
// opens a new TCP connection per request and sends `Connection: close` both
// ways, so every /api call parks two ports in TIME_WAIT for 2 minutes - on
// 2026-09-30 that exhausted the Windows ephemeral port pool mid-suite and the
// e2e run lost random late specs to ERR_ADDRESS_IN_USE. This drives the REAL
// config's proxy entry through a real Vite server to a real target and counts
// the target-side connections, so it fails if the agent is removed, stops
// keeping alive, or stops being passed through.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type ProxyOptions, type UserConfig, type ViteDevServer } from 'vite';

let target: http.Server;
const targetSockets = new Set<number>();
let vite: ViteDevServer;
let vitePort = 0;
let proxyTable: Record<string, string | ProxyOptions>;

beforeAll(async () => {
  target = http.createServer((req, res) => {
    targetSockets.add(req.socket.remotePort ?? -1);
    res.setHeader('content-type', 'application/json');
    res.end('{"ok":true}');
  });
  // The app server's value (app/src/index.ts): the pool must retire idle
  // sockets before this, never the other way round.
  target.keepAliveTimeout = 65_000;
  await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve));
  // The config reads APP_PORT at import time, so point it at the target first.
  process.env['APP_PORT'] = String((target.address() as AddressInfo).port);
  const config = (await import('../../dashboard/vite.config.js')).default as UserConfig;
  proxyTable = config.server?.proxy as Record<string, string | ProxyOptions>;
  vite = await createServer({
    configFile: false,
    logLevel: 'silent',
    server: { port: 0, host: '127.0.0.1', proxy: { '/api': proxyTable['/api']! } },
  });
  await vite.listen();
  vitePort = (vite.httpServer!.address() as AddressInfo).port;
}, 60_000);

afterAll(async () => {
  await vite?.close();
  await new Promise<void>((resolve) => target?.close(() => resolve()));
  delete process.env['APP_PORT'];
});

function get(agent: http.Agent): Promise<{ connection: string | undefined }> {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port: vitePort, path: '/api/ping', agent }, (res) => {
        res.resume();
        res.on('end', () => resolve({ connection: res.headers['connection'] }));
      })
      .on('error', reject);
  });
}

describe('dashboard dev proxy keeps connections to the app alive', () => {
  it('20 sequential /api requests reuse ONE upstream connection and never answer Connection: close', async () => {
    const client = new http.Agent({ keepAlive: true });
    const headers: (string | undefined)[] = [];
    for (let i = 0; i < 20; i++) headers.push((await get(client)).connection);
    client.destroy();
    expect(targetSockets.size, 'distinct proxy->app connections for 20 requests').toBe(1);
    expect(headers.filter((h) => h === 'close')).toEqual([]);
  });

  it('every app-bound proxy entry shares the same keep-alive agent with an idle timeout under the app keepAliveTimeout', () => {
    const entries = Object.values(proxyTable).filter((v): v is ProxyOptions => typeof v === 'object');
    expect(entries.length).toBeGreaterThan(0);
    const agent = entries[0]!.agent as http.Agent & { keepAlive?: boolean; options?: { timeout?: number } };
    expect(agent).toBeInstanceOf(http.Agent);
    expect(agent.keepAlive).toBe(true);
    const idle = agent.options?.timeout ?? 0;
    expect(idle).toBeGreaterThan(0);
    expect(idle).toBeLessThan(65_000);
    for (const entry of entries) expect(entry.agent).toBe(agent);
  });
});
