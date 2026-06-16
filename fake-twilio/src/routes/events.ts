// fake-twilio/src/routes/events.ts
import { Router } from 'express';
import type { FakeTwilioEngine } from '../engine/engine.js';

const HEARTBEAT_MS = 25_000;
const MAX_CONNECTIONS = 25;

/** SSE stream of engine events for the fake-phones UI. Mirrors the app's /api/events. */
export function createEventsRouter(engine: FakeTwilioEngine): Router {
  const router = Router();
  let connections = 0;

  router.get('/control/events', (_req, res) => {
    if (connections >= MAX_CONNECTIONS) {
      res.status(503).json({ error: 'too many event streams' });
      return;
    }
    connections += 1;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': connected\n\n');

    const unsubscribe = engine.subscribe((event) => {
      res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    });
    const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), HEARTBEAT_MS);
    heartbeat.unref();

    // Idempotent cleanup: an errored-but-not-closed socket still leaks a
    // connection slot, the heartbeat timer and the engine subscription unless we
    // tear down on 'error' too. The `done` guard makes the second event a no-op
    // so we never double-decrement `connections` when both fire.
    let done = false;
    const cleanup = (): void => {
      if (done) return;
      done = true;
      connections -= 1;
      clearInterval(heartbeat);
      unsubscribe();
      res.end();
    };

    res.on('close', cleanup);
    res.on('error', cleanup);
  });

  return router;
}
