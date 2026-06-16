// fake-twilio/test/uiServe.test.ts
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { buildFakeTwilioApp } from '../src/server.js';
import { loadFakeConfig } from '../src/config.js';
import { FakeTwilioEngine } from '../src/engine/engine.js';
import { RealClock } from '../src/engine/clock.js';

let distDir: string;
beforeAll(() => {
  distDir = mkdtempSync(path.join(tmpdir(), 'ftui-'));
  mkdirSync(path.join(distDir, 'assets'), { recursive: true });
  writeFileSync(path.join(distDir, 'index.html'), '<!doctype html><title>fake-phones</title>');
  writeFileSync(path.join(distDir, 'assets', 'app.js'), 'console.log(1)');
});
afterAll(() => rmSync(distDir, { recursive: true, force: true }));

function app() {
  const config = loadFakeConfig({ NODE_ENV: 'test', TWILIO_AUTH_TOKEN: 't', FAKE_TWILIO_UI_DIST: distDir });
  const engine = new FakeTwilioEngine({ clock: new RealClock(), dispatcher: { post: async () => 200 } });
  return buildFakeTwilioApp({ config, engine });
}

describe('UI static serving', () => {
  it('serves index.html at /', async () => {
    const res = await request(app()).get('/');
    expect(res.status).toBe(200);
    expect(res.text).toContain('fake-phones');
  });
  it('serves built assets', async () => {
    const res = await request(app()).get('/assets/app.js');
    expect(res.status).toBe(200);
  });
  it('SPA-falls-back unknown GETs to index.html', async () => {
    const res = await request(app()).get('/some/spa/route');
    expect(res.status).toBe(200);
    expect(res.text).toContain('fake-phones');
  });
  it('does NOT hijack the control API or health', async () => {
    expect((await request(app()).get('/health')).body).toMatchObject({ ok: true });
    expect((await request(app()).get('/control/threads')).status).toBe(200);
  });
});
