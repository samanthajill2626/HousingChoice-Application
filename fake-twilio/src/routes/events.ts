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

    res.on('close', () => {
      connections -= 1;
      clearInterval(heartbeat);
      unsubscribe();
      res.end();
    });
  });

  return router;
}
