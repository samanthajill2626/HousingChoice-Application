// ranking.updated (WP1 B2a spec D12): the event is in the value list the
// bridge and the internal route iterate, and the internal route re-emits it
// with no per-event code. The six-key payload (no score, no name, no card
// field) is proven where payloads are BUILT: rankingRunBatch.test.ts
// (toRankingEvent) and rankingRankAnchor.test.ts (every emitted payload).
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/lib/config.js';
import { APP_EVENT_NAMES, createEventBus, type RankingUpdatedEvent } from '../src/lib/events.js';
import { deriveBridgeToken } from '../src/lib/eventBridge.js';
import { createLogger } from '../src/lib/logger.js';
import { createLogCapture } from './helpers/logCapture.js';

const ORIGIN = 'test-origin-secret';
const SESSION = 'test-session-secret';

const PAYLOAD: RankingUpdatedEvent = {
  anchorKind: 'unit',
  anchorId: 'unit-1',
  generation: 'gen-1',
  status: 'running',
  batchesDone: 1,
  batchCount: 3,
};

describe('ranking.updated', () => {
  it('is in APP_EVENT_NAMES, so the bridge subscribes it with no new code', () => {
    expect(APP_EVENT_NAMES).toContain('ranking.updated');
  });

  it('crosses POST /internal/events and is re-emitted on the app bus', async () => {
    const events = createEventBus();
    const logger = createLogger({ destination: createLogCapture().stream });
    const config = loadConfig({ NODE_ENV: 'test', CF_ORIGIN_SECRET: ORIGIN, SESSION_SECRET: SESSION });
    const app = buildApp({ config, logger, api: { events } });
    const seen: RankingUpdatedEvent[] = [];
    events.on('ranking.updated', (p) => seen.push(p));
    const res = await request(app)
      .post('/internal/events')
      .set('x-origin-verify', ORIGIN)
      .set('x-bridge-token', deriveBridgeToken(SESSION))
      .send({ name: 'ranking.updated', payload: PAYLOAD });
    expect(res.status).toBe(204);
    expect(seen).toEqual([PAYLOAD]);
  });
});
