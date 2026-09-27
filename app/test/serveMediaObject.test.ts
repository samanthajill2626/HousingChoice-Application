// app/test/serveMediaObject.test.ts
// The shared media-serving helper (routes/serveMediaObject.ts) behind the call
// recording route and the voicemail greeting audio route. Its range, 404, 416
// and cache behavior is pinned through those routes (voiceRecording.test.ts,
// voicemailGreetingRoutes.test.ts). THIS file pins the stream lifecycle when
// the CLIENT leaves (voicemail-greeting fix wave R1, FW1; spec 4.10: a client
// abort is never an ERROR, because ERROR lines feed the alarms).
//
// In production the body is an S3 GetObject response holding a pooled socket.
// pipe() only UNPIPES when the response closes, which left that body paused
// and open until S3 dropped the idle connection - and the resulting 'error'
// logged an ERROR for a client that had simply left. The greeting player's
// preload="metadata" read makes that frequent: every Voice-tab view fetches
// the greeting and may stop reading after the header. A never-ending
// PassThrough stands in for the S3 body here.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { PassThrough } from 'node:stream';
import express, { type Request, type Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import type { MediaStore } from '../src/adapters/mediaStore.js';
import { createLogger } from '../src/lib/logger.js';
import { serveMediaObject } from '../src/routes/serveMediaObject.js';
import { createLogCapture } from './helpers/logCapture.js';

const ERRORED = 'test media stream errored mid-flight';

/**
 * A mini app that serves ONE store body through the helper. `beforeServe` runs
 * inside the handler before the helper is called - the seam for a client that
 * leaves while the store is still answering.
 */
function serveBody(
  body: PassThrough,
  beforeServe: (req: Request, res: Response) => Promise<void> = async () => {},
) {
  const capture = createLogCapture();
  const log = createLogger({ level: 'info', destination: capture.stream });
  // Only getStream is reached on these paths (no Range header, so no 416 head).
  const mediaStore = { getStream: async () => ({ body, contentType: 'audio/mpeg' }) } as unknown as MediaStore;
  const app = express();
  app.get('/audio', async (req, res) => {
    await beforeServe(req, res);
    await serveMediaObject(req, res, {
      mediaStore,
      key: 'settings/voicemail-greeting',
      defaultContentType: 'audio/mpeg',
      cacheControl: 'private, max-age=3600',
      notFoundError: 'greeting_not_found',
      log,
      logContext: { s3Key: 'settings/voicemail-greeting' },
      messages: { missing: 'test object missing', streaming: 'test streaming', errored: ERRORED },
    });
  });
  const server = app.listen(0);
  const port = (server.address() as AddressInfo).port;
  const close = async (): Promise<void> => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  return { capture, port, close };
}

describe('serveMediaObject - the store body when the client leaves (FW1, spec 4.10)', () => {
  it('a client that leaves mid-stream: the body is destroyed WITHOUT an error and no ERROR line follows', async () => {
    const body = new PassThrough();
    const { capture, port, close } = serveBody(body);
    try {
      body.write(Buffer.alloc(1024, 1)); // the first chunk; this body never ends on its own
      await new Promise<void>((resolve) => {
        const req = http.get({ host: '127.0.0.1', port, path: '/audio' }, (res) => {
          res.once('data', () => {
            req.destroy(); // the client leaves after the first chunk
            resolve();
          });
        });
        req.on('error', () => {}); // the destroy above IS the scenario
      });
      await vi.waitFor(() => expect(body.destroyed).toBe(true), { timeout: 2000 });
      expect(body.errored).toBeNull();
      // Stand-in for the upstream reset that used to follow an abandoned S3
      // body: on a released body it is a no-op, so it can never log an ERROR.
      body.destroy(new Error('upstream reset after the client left'));
      await new Promise((r) => setTimeout(r, 50));
      expect(capture.atLevel(50)).toEqual([]);
    } finally {
      await close();
    }
  });

  it('a client that left while the store was still answering: the body is released too, never left open', async () => {
    const body = new PassThrough();
    let requestSeen = false;
    const { capture, port, close } = serveBody(body, async (_req, res) => {
      requestSeen = true;
      // Hold the handler until the response has CLOSED, so the helper starts on
      // a response whose 'close' already fired - a client that left while the
      // store's GetObject was in flight.
      await new Promise<void>((resolve) => res.once('close', () => resolve()));
    });
    try {
      body.write(Buffer.alloc(1024, 1));
      const req = http.get({ host: '127.0.0.1', port, path: '/audio' });
      req.on('error', () => {}); // the destroy below IS the scenario
      await vi.waitFor(() => expect(requestSeen).toBe(true), { timeout: 2000 });
      req.destroy();
      await vi.waitFor(() => expect(body.destroyed).toBe(true), { timeout: 2000 });
      expect(body.errored).toBeNull();
      expect(capture.atLevel(50)).toEqual([]);
    } finally {
      await close();
    }
  });

  it('a genuine upstream failure while the client is still connected stays ONE ERROR and cuts the response', async () => {
    const body = new PassThrough();
    const { capture, port, close } = serveBody(body);
    try {
      body.write(Buffer.alloc(1024, 1));
      const complete = await new Promise<boolean>((resolve) => {
        const req = http.get({ host: '127.0.0.1', port, path: '/audio' }, (res) => {
          res.on('error', () => {}); // the cut surfaces here as an aborted response
          res.once('data', () => body.destroy(new Error('upstream reset mid-stream')));
          res.on('close', () => resolve(res.complete));
        });
        req.on('error', () => resolve(false));
      });
      expect(complete).toBe(false);
      await vi.waitFor(() => expect(capture.atLevel(50)).toHaveLength(1), { timeout: 2000 });
      expect(capture.atLevel(50)[0]?.['msg']).toBe(ERRORED);
    } finally {
      await close();
    }
  });
});
