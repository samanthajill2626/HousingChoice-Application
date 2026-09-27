// Voicemail greeting routes (spec 2026-09-26 sections 4.3-4.5). Task 2 owns the
// parsePatch pin; Task 4 adds the upload/remove/serve cases below it.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createLogger } from '../src/lib/logger.js';
import { minimalMp3 } from '../src/lib/seed/media.js';
import { VOICEMAIL_GREETING_REJECT_MESSAGE, VOICEMAIL_GREETING_S3_KEY } from '../src/lib/voicemailGreeting.js';
import type { AuthedRequest } from '../src/middleware/auth.js';
import { createSettingsRouter } from '../src/routes/settings.js';
import { minimalWav } from './helpers/audioFixtures.js';
import { TEST_ADMIN_COOKIE, TEST_ADMIN_USER, TEST_SESSION_COOKIE } from './helpers/authSession.js';
import { makeWebhookHarness, ORIGIN_SECRET } from './helpers/twilioWebhookHarness.js';

const GREETING = {
  s3Key: 'settings/voicemail-greeting',
  contentType: 'audio/mpeg',
  fileName: 'sam.mp3',
  sizeBytes: 427,
  uploadedAt: '2026-09-26T12:00:00.000Z',
  uploadedByUserId: 'user-0001',
  uploadedByEmail: 'founder@example.com',
} as const;

describe('PUT /api/settings ignores voicemailGreeting (only the greeting routes write it)', () => {
  it('a body carrying it changes nothing', async () => {
    const { app, world } = makeWebhookHarness();
    const res = await request(app)
      .put('/api/settings')
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_ADMIN_COOKIE)
      .send({ voicemailGreeting: GREETING, missedCallAutoTextEnabled: false });
    expect(res.status).toBe(200);
    expect(res.body.settings.voicemailGreeting).toBeUndefined();
    expect(world.settings.voicemailGreeting).toBeUndefined();
    expect(world.settings.missedCallAutoTextEnabled).toBe(false);
  });
});

const KEY = VOICEMAIL_GREETING_S3_KEY;
const PATH = '/api/settings/voicemail-greeting';

// supertest/superagent send `Connection: close` by default. Node then closes
// the socket the moment the response finishes; a client still uploading gets
// RST before it reads the 4xx JSON (measured: ECONNRESET on every 3 MiB /
// 6 MiB refusal, 400/413 JSON with keep-alive). Browsers keep connections
// alive, so keep-alive is the realistic shape - and the ONLY way these tests
// can observe the JSON the route really sends.
function keepAlive(req: request.Test): request.Test {
  return req.set('connection', 'keep-alive');
}

/** A valid MP3 padded with zero bytes to `total` (still sniffs as MP3). */
function bigMp3(total: number): Buffer {
  const head = minimalMp3();
  return Buffer.concat([head, Buffer.alloc(total - head.length, 0)]);
}
/** WAV bytes padded to `total` - declared as MP3 they must FAIL the sniff. */
function bigWav(total: number): Buffer {
  return minimalWav(total - 44);
}

function admin(req: request.Test): request.Test {
  return keepAlive(req.set('x-origin-verify', ORIGIN_SECRET).set('cookie', TEST_ADMIN_COOKIE));
}

async function upload(
  app: Parameters<typeof request>[0],
  body: Buffer,
  contentType: string,
  name = 'greeting.mp3',
  extra: (t: request.Test) => request.Test = (t) => t,
) {
  return extra(admin(request(app).put(PATH)))
    .set('content-type', contentType)
    .set('x-greeting-file-name', encodeURIComponent(name))
    .send(body);
}

describe('PUT /api/settings/voicemail-greeting - gates', () => {
  it('401 without a session, 403 for a VA', async () => {
    const { app } = makeWebhookHarness();
    expect((await request(app).put(PATH).set('x-origin-verify', ORIGIN_SECRET).set('content-type', 'audio/mpeg').send(minimalMp3())).status).toBe(401);
    expect((await request(app).put(PATH).set('x-origin-verify', ORIGIN_SECRET).set('cookie', TEST_SESSION_COOKIE).set('content-type', 'audio/mpeg').send(minimalMp3())).status).toBe(403);
  });

  it('503 media_storage_unavailable without a media store', async () => {
    const { app } = makeWebhookHarness({ withoutMediaStore: true });
    const res = await upload(app, minimalMp3(), 'audio/mpeg');
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('media_storage_unavailable');
  });

  it('400 unsupported_media_type with the exact message for audio/mp4 and for an ABSENT type', async () => {
    const { app, world } = makeWebhookHarness();
    const res = await upload(app, minimalMp3(), 'audio/mp4');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'unsupported_media_type', message: VOICEMAIL_GREETING_REJECT_MESSAGE });
    const absent = await admin(request(app).put(PATH)).send(minimalMp3());
    expect(absent.status).toBe(400);
    expect(absent.body.error).toBe('unsupported_media_type');
    expect(world.mediaPuts).toHaveLength(0);
  });

  it('400 empty_file for Content-Length: 0', async () => {
    const { app } = makeWebhookHarness();
    const res = await admin(request(app).put(PATH)).set('content-type', 'audio/mpeg').set('content-length', '0').send();
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('empty_file');
  });

  it('the 11th upload inside a minute is 429 rate_limited (10 uploads/min/user, spec 4.3)', async () => {
    const { app, world } = makeWebhookHarness();
    for (let i = 0; i < 10; i += 1) {
      expect((await upload(app, minimalMp3(), 'audio/mpeg')).status).toBe(200);
    }
    const limited = await upload(app, minimalMp3(), 'audio/mpeg');
    expect(limited.status).toBe(429);
    expect(limited.body.error).toBe('rate_limited');
    expect(world.mediaPuts).toHaveLength(10);
  });
});

/**
 * Large-body requests go over a RAW keep-alive http.Agent against app.listen(0):
 * supertest's keep-alive variant works but its server close waits out the
 * draining connection (~6 s per refusal, measured); destroying our own agent
 * before server.close() makes teardown immediate. `body` is either a Buffer
 * (Content-Length set) or an array of Buffers written chunked (no length).
 */
async function rawPut(
  app: Parameters<typeof request>[0],
  opts: { body: Buffer | Buffer[]; contentType?: string; name?: string; cookie?: string },
): Promise<{ status: number; json: Record<string, unknown> }> {
  const server = (app as unknown as { listen: (port: number) => http.Server }).listen(0);
  const agent = new http.Agent({ keepAlive: true });
  try {
    const port = (server.address() as AddressInfo).port;
    return await new Promise((resolve, reject) => {
      const chunked = Array.isArray(opts.body);
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          method: 'PUT',
          path: PATH,
          agent,
          headers: {
            'x-origin-verify': ORIGIN_SECRET,
            cookie: opts.cookie ?? TEST_ADMIN_COOKIE,
            ...(opts.contentType !== undefined && { 'content-type': opts.contentType }),
            'x-greeting-file-name': encodeURIComponent(opts.name ?? 'greeting.mp3'),
            ...(chunked
              ? { 'transfer-encoding': 'chunked' }
              : { 'content-length': String((opts.body as Buffer).length) }),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            // Reject (never throw here): a throw inside 'end' is an uncaught
            // exception and leaves this promise pending until the test times out.
            const text = Buffer.concat(chunks).toString('utf8');
            try {
              resolve({ status: res.statusCode ?? 0, json: JSON.parse(text) as Record<string, unknown> });
            } catch {
              reject(new Error(`non-JSON ${res.statusCode ?? 0} response: ${text.slice(0, 120)}`));
            }
          });
        },
      );
      req.on('error', reject);
      if (chunked) {
        const parts = opts.body as Buffer[];
        for (const part of parts.slice(0, -1)) req.write(part);
        req.end(parts[parts.length - 1]);
      } else {
        req.end(opts.body as Buffer);
      }
    });
  } finally {
    agent.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/**
 * A refusal must DRAIN the refused body (spec 4.3), and draining is what hands
 * the SAME keep-alive connection back for the next request - so reuse is the
 * observable proof of the wiring. On loopback the refusal JSON can outrun both
 * a `Connection: close` response and an undrained stream.pipeline: with either
 * swapped into the route (probed on Node 24), every rawPut case below still
 * passed and only this reuse check went red. `maxSockets: 1` queues the GET
 * until the PUT's socket is freed, which happens only once its body was fully
 * sent AND read.
 */
async function refuseThenReuse(
  app: Parameters<typeof request>[0],
  put: { body: Buffer | Buffer[]; contentType: string },
): Promise<{ putStatus: number; getStatus: number; reusedSocket: boolean }> {
  const server = (app as unknown as { listen: (port: number) => http.Server }).listen(0);
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  const port = (server.address() as AddressInfo).port;
  const exchange = (method: string, path: string, headers: http.OutgoingHttpHeaders, body: Buffer[]) =>
    new Promise<{ status: number; reusedSocket: boolean }>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, method, path, agent, headers }, (res) => {
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode ?? 0, reusedSocket: req.reusedSocket }));
      });
      req.on('error', reject);
      for (const part of body.slice(0, -1)) req.write(part);
      req.end(body[body.length - 1]);
    });
  try {
    const chunked = Array.isArray(put.body);
    const first = await exchange(
      'PUT',
      PATH,
      {
        'x-origin-verify': ORIGIN_SECRET,
        cookie: TEST_ADMIN_COOKIE,
        'content-type': put.contentType,
        ...(chunked ? { 'transfer-encoding': 'chunked' } : { 'content-length': String((put.body as Buffer).length) }),
      },
      chunked ? (put.body as Buffer[]) : [put.body as Buffer],
    );
    const next = await exchange('GET', '/api/settings', { 'x-origin-verify': ORIGIN_SECRET, cookie: TEST_ADMIN_COOKIE }, []);
    return { putStatus: first.status, getStatus: next.status, reusedSocket: next.reusedSocket };
  } finally {
    agent.destroy();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe('PUT /api/settings/voicemail-greeting - the sniff and the cap (bodies big enough to expose a socket reset)', () => {
  it('every refusal DRAINS the body: the same keep-alive connection then serves the next request', async () => {
    const { app } = makeWebhookHarness();
    const big = bigMp3(6 * 1024 * 1024);
    const cases = [
      { body: bigWav(3 * 1024 * 1024), contentType: 'audio/mpeg', status: 400 }, // the sniff (gate)
      { body: big, contentType: 'audio/mpeg', status: 413 }, // Content-Length over the cap (early)
      { body: [big.subarray(0, 2 * 1024 * 1024), big.subarray(2 * 1024 * 1024)], contentType: 'audio/mpeg', status: 413 }, // chunked (gate)
    ];
    for (const put of cases) {
      expect(await refuseThenReuse(app, put)).toEqual({ putStatus: put.status, getStatus: 200, reusedSocket: true });
    }
  });

  it('a 3 MiB body of WAV bytes declared audio/mpeg is refused with the M4A message, the JSON reaches the client, no put, not logged as an abort', async () => {
    const { app, world, capture } = makeWebhookHarness();
    const res = await rawPut(app, { body: bigWav(3 * 1024 * 1024), contentType: 'audio/mpeg' });
    expect(res.status).toBe(400);
    expect(res.json).toEqual({ error: 'unsupported_media_type', message: VOICEMAIL_GREETING_REJECT_MESSAGE });
    expect(world.mediaPuts).toHaveLength(0);
    expect(capture.lines.some((l) => l['reason'] === 'client_aborted')).toBe(false);
  });

  it('413 file_too_large for a 6 MiB body with a Content-Length, and the JSON reaches the client', async () => {
    const { app, world } = makeWebhookHarness();
    const res = await rawPut(app, { body: bigMp3(6 * 1024 * 1024), contentType: 'audio/mpeg' });
    expect(res.status).toBe(413);
    expect(res.json['error']).toBe('file_too_large');
    expect(res.json['maxBytes']).toBe(5 * 1024 * 1024);
    expect(world.mediaPuts).toHaveLength(0);
  });

  it('413 file_too_large for a CHUNKED 6 MiB body (no Content-Length), and the JSON reaches the client', async () => {
    // superagent cannot stream a Readable; rawPut writes the two halves chunked.
    const { app, world } = makeWebhookHarness();
    const body = bigMp3(6 * 1024 * 1024);
    const res = await rawPut(app, { body: [body.subarray(0, 2 * 1024 * 1024), body.subarray(2 * 1024 * 1024)], contentType: 'audio/mpeg' });
    expect(res.status).toBe(413);
    expect(res.json['error']).toBe('file_too_large');
    expect(world.mediaPuts).toHaveLength(0);
  });
});

describe('PUT /api/settings/voicemail-greeting - a client that disconnects (client_aborted)', () => {
  it('stores nothing and logs ONE WARN client_aborted with the actor, never an ERROR (spec 4.3, 4.10)', async () => {
    const { app, world, capture } = makeWebhookHarness();
    // Learn when the route has begun streaming into the store: by then its
    // request listeners are attached, so the disconnect lands MID-upload.
    const put = world.mediaStore.put.bind(world.mediaStore);
    let putStarted = false;
    world.mediaStore.put = (key, body, contentType) => {
      putStarted = true;
      return put(key, body, contentType);
    };
    const server = (app as unknown as { listen: (port: number) => http.Server }).listen(0);
    // Keep-alive, like a browser (see keepAlive above).
    const agent = new http.Agent({ keepAlive: true });
    try {
      const port = (server.address() as AddressInfo).port;
      const req = http.request({
        host: '127.0.0.1',
        port,
        method: 'PUT',
        path: PATH,
        agent,
        headers: {
          'x-origin-verify': ORIGIN_SECRET,
          cookie: TEST_ADMIN_COOKIE,
          'content-type': 'audio/mpeg',
          'x-greeting-file-name': encodeURIComponent('greeting.mp3'),
          'content-length': String(1024 * 1024),
        },
      });
      req.on('error', () => {}); // the destroy below IS the scenario
      req.write(bigMp3(64 * 1024));
      // Bounded: a route that never begins the upload fails here in seconds,
      // not at the suite timeout (the body is deliberately never finished).
      await vi.waitFor(() => expect(putStarted).toBe(true), { timeout: 5000 });
      req.destroy();
      await vi.waitFor(
        () => {
          expect(capture.atLevel(40).filter((l) => l['reason'] === 'client_aborted')).toHaveLength(1);
        },
        { timeout: 5000 },
      );
      const warn = capture.atLevel(40).find((l) => l['reason'] === 'client_aborted');
      expect(warn?.['actor']).toBe(TEST_ADMIN_USER.userId);
      expect(world.mediaPuts).toHaveLength(0);
      expect(world.settings.voicemailGreeting).toBeUndefined();
      expect(capture.atLevel(50)).toEqual([]);
    } finally {
      agent.destroy();
      // If the route ever stops reading, its socket pauses and never learns
      // the client left; close every connection so teardown cannot hang.
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('a client gone BEFORE the handler runs still ends in ONE WARN client_aborted, never a put() left waiting', async () => {
    // The real /api chain awaits the session check before this route runs. A
    // client that disconnects inside that gap - before its bytes fill the
    // unread request's buffer, so the server is still reading and sees the
    // close - has ALREADY emitted 'close' when the handler attaches its
    // listeners. A mini app reproduces the gap deterministically: its auth
    // stand-in calls next() only after 'close'. (A bigger first write pauses
    // the server socket, the close goes unseen until the route resumes it,
    // and the listeners then hear it - the mid-upload case above.)
    const { world, config, capture } = makeWebhookHarness();
    let requestSeen = false;
    const app = express();
    app.use((req: AuthedRequest, _res, next) => {
      req.user = TEST_ADMIN_USER;
      requestSeen = true;
      req.once('close', () => next());
    });
    app.use(
      '/api/settings',
      createSettingsRouter({
        config,
        logger: createLogger({ level: 'info', destination: capture.stream }),
        settingsRepo: world.settingsRepo,
        auditRepo: world.auditRepo,
        mediaStore: world.mediaStore,
      }),
    );
    const server = app.listen(0);
    const agent = new http.Agent({ keepAlive: true });
    try {
      const port = (server.address() as AddressInfo).port;
      const req = http.request({
        host: '127.0.0.1',
        port,
        method: 'PUT',
        path: PATH,
        agent,
        headers: { 'content-type': 'audio/mpeg', 'content-length': String(1024 * 1024) },
      });
      req.on('error', () => {}); // the destroy below IS the scenario
      req.write(bigMp3(1024));
      await vi.waitFor(() => expect(requestSeen).toBe(true), { timeout: 5000 });
      req.destroy();
      await vi.waitFor(
        () => {
          expect(capture.atLevel(40).filter((l) => l['reason'] === 'client_aborted')).toHaveLength(1);
        },
        { timeout: 5000 },
      );
      expect(world.mediaPuts).toHaveLength(0);
      expect(capture.atLevel(50)).toEqual([]);
    } finally {
      agent.destroy();
      // A server-side socket that stopped reading never learns the client
      // left; close every connection so teardown cannot wait on one.
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('PUT/DELETE /api/settings/voicemail-greeting - happy paths', () => {
  it('stores an MP3 under the fixed key, records it, audits it, and GET /api/settings carries it', async () => {
    const { app, world } = makeWebhookHarness();
    const res = await upload(app, minimalMp3(), 'audio/mpeg', 'Sam greeting.mp3');
    expect(res.status).toBe(200);
    expect(res.body.voicemailGreeting).toMatchObject({
      s3Key: KEY,
      contentType: 'audio/mpeg',
      fileName: 'Sam greeting.mp3',
      sizeBytes: minimalMp3().length,
      uploadedByUserId: TEST_ADMIN_USER.userId,
      uploadedByEmail: TEST_ADMIN_USER.email,
    });
    expect(typeof res.body.voicemailGreeting.uploadedAt).toBe('string');
    expect(world.mediaPuts).toEqual([{ key: KEY, contentType: 'audio/mpeg', bytes: minimalMp3().length }]);
    expect(world.mediaObjects.get(KEY)?.body.equals(minimalMp3())).toBe(true);
    expect(world.settings.voicemailGreeting?.fileName).toBe('Sam greeting.mp3');
    const audit = world.auditEvents.find((e) => e.event_type === 'settings_updated');
    expect(audit?.payload).toMatchObject({ fields: ['voicemailGreeting'], action: 'uploaded', actor: TEST_ADMIN_USER.userId });
    const settings = await admin(request(app).get('/api/settings'));
    expect(settings.body.settings.voicemailGreeting.fileName).toBe('Sam greeting.mp3');
  });

  it('accepts audio/x-wav and stores the canonical audio/wav', async () => {
    const { app, world } = makeWebhookHarness();
    const res = await upload(app, minimalWav(), 'audio/x-wav', 'g.wav');
    expect(res.status).toBe(200);
    expect(res.body.voicemailGreeting.contentType).toBe('audio/wav');
    expect(world.mediaPuts[0]?.contentType).toBe('audio/wav');
  });

  it('decodes a percent-encoded non-ASCII name and falls back on a bad encoding', async () => {
    const { app } = makeWebhookHarness();
    // "Sam" + U+00E9 (e-acute), built from its code point so the source stays ASCII.
    const accented = `Sam${String.fromCodePoint(0xe9)} greeting.mp3`;
    const ok = await upload(app, minimalMp3(), 'audio/mpeg', accented);
    expect(ok.body.voicemailGreeting.fileName).toBe(accented);
    const bad = await admin(request(app).put(PATH)).set('content-type', 'audio/mpeg').set('x-greeting-file-name', '%E0%A4%A').send(minimalMp3());
    expect(bad.status).toBe(200);
    expect(bad.body.voicemailGreeting.fileName).toBe('greeting.mp3');
  });

  it('never logs the file name', async () => {
    const { app, capture } = makeWebhookHarness();
    const res = await upload(app, minimalMp3(), 'audio/mpeg', 'SECRET-NAME.mp3');
    // Not vacuous: the upload landed and the name was stored - just never logged.
    expect(res.status).toBe(200);
    expect(res.body.voicemailGreeting.fileName).toBe('SECRET-NAME.mp3');
    expect(JSON.stringify(capture.lines)).not.toContain('SECRET-NAME');
  });

  it('replace overwrites (second put, uploadedAt advances); a refused replace leaves the object byte-identical and the record unchanged', async () => {
    const { app, world } = makeWebhookHarness();
    const first = await upload(app, minimalMp3(), 'audio/mpeg', 'one.mp3');
    await new Promise((r) => setTimeout(r, 5));
    const second = await upload(app, minimalWav(), 'audio/wav', 'two.wav');
    expect(second.status).toBe(200);
    expect(world.mediaPuts).toHaveLength(2);
    expect(second.body.voicemailGreeting.uploadedAt > first.body.voicemailGreeting.uploadedAt).toBe(true);
    expect(world.mediaObjects.get(KEY)?.body.equals(minimalWav())).toBe(true);

    const refused = await rawPut(app, { body: bigWav(3 * 1024 * 1024), contentType: 'audio/mpeg', name: 'three.mp3' });
    expect(refused.status).toBe(400);
    const tooBig = await rawPut(app, { body: bigMp3(6 * 1024 * 1024), contentType: 'audio/mpeg', name: 'four.mp3' });
    expect(tooBig.status).toBe(413);
    expect(world.mediaPuts).toHaveLength(2);
    expect(world.mediaObjects.get(KEY)?.body.equals(minimalWav())).toBe(true);
    expect(world.settings.voicemailGreeting?.fileName).toBe('two.wav');
  });

  it('an audit failure after a successful upload still answers 200 (ERROR logged)', async () => {
    const { app, world, capture } = makeWebhookHarness();
    world.failAuditAppendFor.add('settings_updated');
    const res = await upload(app, minimalMp3(), 'audio/mpeg');
    expect(res.status).toBe(200);
    expect(world.settings.voicemailGreeting?.s3Key).toBe(KEY);
    expect(capture.atLevel(50).some((l) => String(l['msg']).includes('audit'))).toBe(true);
  });

  it('a failed put is a server fault: 500 upload_failed, ONE ERROR, nothing recorded', async () => {
    const { app, world, capture } = makeWebhookHarness();
    world.mediaStore.put = async () => {
      throw new Error('fake S3 PutObject failure');
    };
    const res = await upload(app, minimalMp3(), 'audio/mpeg');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'upload_failed' });
    expect(world.settings.voicemailGreeting).toBeUndefined();
    expect(capture.atLevel(50).filter((l) => l['msg'] === 'voicemail greeting upload failed')).toHaveLength(1);
  });

  it('a failed record write after the put: 500 greeting_record_failed, ONE ERROR, the bytes stay stored', async () => {
    const { app, world, capture } = makeWebhookHarness();
    world.settingsRepo.putOrgSettings = async () => {
      throw new Error('fake settings write failure');
    };
    const res = await upload(app, minimalMp3(), 'audio/mpeg');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'greeting_record_failed' });
    expect(world.mediaPuts).toEqual([{ key: KEY, contentType: 'audio/mpeg', bytes: minimalMp3().length }]);
    expect(
      capture.atLevel(50).filter((l) => l['msg'] === 'voicemail greeting stored but the settings record write failed'),
    ).toHaveLength(1);
  });

  it('DELETE clears the record, deletes the object (best effort), audits removed, 204; idempotent', async () => {
    const { app, world } = makeWebhookHarness();
    await upload(app, minimalMp3(), 'audio/mpeg');
    const res = await admin(request(app).delete(PATH));
    expect(res.status).toBe(204);
    expect(world.settings.voicemailGreeting).toBeUndefined();
    expect(world.deletedMediaKeys).toEqual([KEY]);
    expect(world.mediaObjects.has(KEY)).toBe(false);
    const audit = world.auditEvents.filter((e) => e.event_type === 'settings_updated');
    expect(audit[audit.length - 1]?.payload).toMatchObject({ fields: ['voicemailGreeting'], action: 'removed' });
    expect((await admin(request(app).delete(PATH))).status).toBe(204);
  });

  it('DELETE still clears the record and answers 204 with a WARN when the object delete rejects', async () => {
    const { app, world, capture } = makeWebhookHarness();
    await upload(app, minimalMp3(), 'audio/mpeg');
    world.failMediaDeletes.add(KEY);
    const res = await admin(request(app).delete(PATH));
    expect(res.status).toBe(204);
    expect(world.settings.voicemailGreeting).toBeUndefined();
    expect(capture.atLevel(40).some((l) => String(l['msg']).includes('voicemail greeting object delete failed'))).toBe(true);
  });

  it('DELETE is admin-only', async () => {
    const { app } = makeWebhookHarness();
    expect((await request(app).delete(PATH).set('x-origin-verify', ORIGIN_SECRET).set('cookie', TEST_SESSION_COOKIE)).status).toBe(403);
  });
});

describe('GET /api/settings/voicemail-greeting/audio', () => {
  const AUDIO = `${PATH}/audio`;
  function bytesOf(t: request.Test): request.Test {
    return t.buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on('data', (c: Buffer) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
  }

  it('404 greeting_not_found when nothing is set', async () => {
    const { app } = makeWebhookHarness();
    const res = await request(app).get(AUDIO).set('x-origin-verify', ORIGIN_SECRET).set('cookie', TEST_SESSION_COOKIE);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('greeting_not_found');
  });

  it('streams the bytes to ANY logged-in user with Accept-Ranges and the stored type; 206 on a range', async () => {
    const { app } = makeWebhookHarness();
    await upload(app, minimalWav(100), 'audio/wav');
    const res = await bytesOf(request(app).get(AUDIO).set('x-origin-verify', ORIGIN_SECRET).set('cookie', TEST_SESSION_COOKIE));
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('audio/wav');
    expect(res.headers['accept-ranges']).toBe('bytes');
    expect(res.headers['cache-control']).toBe('private, max-age=3600');
    expect((res.body as Buffer).equals(minimalWav(100))).toBe(true);
    const part = await bytesOf(request(app).get(AUDIO).set('x-origin-verify', ORIGIN_SECRET).set('cookie', TEST_SESSION_COOKIE).set('range', 'bytes=0-3'));
    expect(part.status).toBe(206);
    expect(part.headers['content-range']).toBe(`bytes 0-3/${minimalWav(100).length}`);
    expect((part.body as Buffer).toString('latin1')).toBe('RIFF');
  });

  it('404 when the record is set but the object is gone', async () => {
    const { app, world } = makeWebhookHarness();
    await upload(app, minimalMp3(), 'audio/mpeg');
    world.mediaObjects.delete(KEY);
    const res = await request(app).get(AUDIO).set('x-origin-verify', ORIGIN_SECRET).set('cookie', TEST_SESSION_COOKIE);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('greeting_not_found');
  });

  it('401 without a session', async () => {
    const { app } = makeWebhookHarness();
    expect((await request(app).get(AUDIO).set('x-origin-verify', ORIGIN_SECRET)).status).toBe(401);
  });

  // Fix wave R1, FW4 (spec 4.2 fixed-key rule, plan Review Focus 5): the
  // harness settings fake projects the record like the real repo, so a record
  // naming any key but the fixed one is NO greeting here too. The object at the
  // foreign key EXISTS, so serving it would be observable.
  it('a record naming a FOREIGN key (a call recording) is no greeting: 404 greeting_not_found, never the recording bytes', async () => {
    const { app, world } = makeWebhookHarness();
    world.mediaObjects.set('recordings/CA1/RE1', { body: Buffer.from('RECORDING-BYTES'), contentType: 'audio/mpeg' });
    world.settings.voicemailGreeting = { ...GREETING, s3Key: 'recordings/CA1/RE1' };
    const res = await bytesOf(request(app).get(AUDIO).set('x-origin-verify', ORIGIN_SECRET).set('cookie', TEST_SESSION_COOKIE));
    expect(res.status).toBe(404);
    expect(JSON.parse((res.body as Buffer).toString('utf8'))).toEqual({ error: 'greeting_not_found' });
    const settings = await request(app).get('/api/settings').set('x-origin-verify', ORIGIN_SECRET).set('cookie', TEST_SESSION_COOKIE);
    expect(settings.body.settings.voicemailGreeting).toBeUndefined();
  });

  it('defense in depth: even a settings read that hands back a FOREIGN key serves only the FIXED key', async () => {
    const { app, world } = makeWebhookHarness();
    world.mediaObjects.set(KEY, { body: Buffer.from('GREETING-BYTES'), contentType: 'audio/mpeg' });
    world.mediaObjects.set('recordings/CA1/RE1', { body: Buffer.from('RECORDING-BYTES'), contentType: 'audio/mpeg' });
    // Stands in for a broken projection or a second writer of the map: the
    // router holds the repo OBJECT, so replacing the method is what it calls.
    const real = world.settingsRepo.getOrgSettings;
    world.settingsRepo.getOrgSettings = async () => ({ ...(await real()), voicemailGreeting: { ...GREETING, s3Key: 'recordings/CA1/RE1' } });
    try {
      const res = await bytesOf(request(app).get(AUDIO).set('x-origin-verify', ORIGIN_SECRET).set('cookie', TEST_SESSION_COOKIE));
      expect(res.status).toBe(200);
      expect((res.body as Buffer).toString('utf8')).toBe('GREETING-BYTES');
    } finally {
      world.settingsRepo.getOrgSettings = real;
    }
  });
});
