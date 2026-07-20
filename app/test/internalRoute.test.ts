import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/lib/config.js';
import { createEventBus } from '../src/lib/events.js';
import { deriveBridgeToken } from '../src/lib/eventBridge.js';
import { createLogger } from '../src/lib/logger.js';
import { createLogCapture } from './helpers/logCapture.js';

// POST /internal/events - the cross-process event bridge, APP side (spec:
// docs/superpowers/specs/2026-07-20-event-bridge-design.md). Two fences: the
// locked origin-secret chain (a route-stage mount, so a request without
// x-origin-verify already died at stage 2) AND the HKDF bridge token. The route
// re-emits a valid name+payload on the SAME bus the SSE route serves; the
// provided token value is NEVER logged (PII/secret posture).

const ORIGIN = 'test-origin-secret';
const SESSION = 'test-session-secret';
const TOKEN = deriveBridgeToken(SESSION);

function makeApp() {
  const events = createEventBus();
  const capture = createLogCapture();
  const logger = createLogger({ destination: capture.stream });
  const config = loadConfig({ NODE_ENV: 'test', CF_ORIGIN_SECRET: ORIGIN, SESSION_SECRET: SESSION });
  const app = buildApp({ config, logger, api: { events } });
  return { app, events, capture };
}

describe('POST /internal/events', () => {
  it('403 without the CloudFront origin secret (locked chain holds)', async () => {
    const { app } = makeApp();
    const res = await request(app)
      .post('/internal/events')
      .set('x-bridge-token', TOKEN)
      .send({ name: 'suggestion.updated', payload: { contactId: 'c1' } });
    expect(res.status).toBe(403);
  });

  it('403 on missing and on wrong bridge token - and never logs the provided value', async () => {
    const { app, events, capture } = makeApp();
    let received = 0;
    events.on('suggestion.updated', () => {
      received += 1;
    });
    const missing = await request(app)
      .post('/internal/events')
      .set('x-origin-verify', ORIGIN)
      .send({ name: 'suggestion.updated', payload: { contactId: 'c1' } });
    expect(missing.status).toBe(403);
    const wrong = await request(app)
      .post('/internal/events')
      .set('x-origin-verify', ORIGIN)
      .set('x-bridge-token', 'attacker-guess-value')
      .send({ name: 'suggestion.updated', payload: { contactId: 'c1' } });
    expect(wrong.status).toBe(403);
    expect(received).toBe(0);
    expect(JSON.stringify(capture.lines)).not.toContain('attacker-guess-value');
  });

  it('400 on an unknown event name and on a non-object payload', async () => {
    const { app } = makeApp();
    for (const body of [
      { name: 'not.a.real.event', payload: {} },
      { name: 'suggestion.updated', payload: 'string' },
      { name: 'suggestion.updated', payload: ['array'] },
      { name: 'suggestion.updated' },
      {},
    ]) {
      const res = await request(app)
        .post('/internal/events')
        .set('x-origin-verify', ORIGIN)
        .set('x-bridge-token', TOKEN)
        .send(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
  });

  it('204 + the exact payload re-emits on the app bus', async () => {
    const { app, events } = makeApp();
    const seen: unknown[] = [];
    events.on('suggestion.updated', (p) => seen.push(p));
    const res = await request(app)
      .post('/internal/events')
      .set('x-origin-verify', ORIGIN)
      .set('x-bridge-token', TOKEN)
      .send({ name: 'suggestion.updated', payload: { contactId: 'c-204' } });
    expect(res.status).toBe(204);
    expect(seen).toEqual([{ contactId: 'c-204' }]);
  });
});
