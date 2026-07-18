import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import twilio from 'twilio';
import { createHash } from 'node:crypto';
import { twilioJsonSignatureMiddleware } from '../src/middleware/twilioSignature.js';
import { createLogger } from '../src/lib/logger.js';
import { createLogCapture } from './helpers/logCapture.js';

const AUTH_TOKEN = 'test-twilio-auth-token';
const PUBLIC_BASE_URL = 'https://dxxxx.cloudfront.example';

const quietLogger = () => createLogger({ destination: createLogCapture().stream });

function makeApp(over: { authToken?: string; publicBaseUrl?: string; nodeEnv?: string } = {}): express.Express {
  const app = express();
  app.use(
    express.json({
      verify: (req, _res, buf) => {
        (req as { rawBody?: Buffer }).rawBody = buf;
      },
    }),
  );
  app.post(
    '/hook',
    twilioJsonSignatureMiddleware({
      authToken: 'authToken' in over ? over.authToken : AUTH_TOKEN,
      publicBaseUrl: 'publicBaseUrl' in over ? over.publicBaseUrl : PUBLIC_BASE_URL,
      nodeEnv: over.nodeEnv ?? 'production',
      logger: quietLogger(),
    }),
    (_req, res) => res.status(200).json({ ok: true }),
  );
  return app;
}

// Sign the bodySHA256 scheme exactly as the middleware's validateRequestWithBody
// validates it: URL carries ?bodySHA256=<sha256hex(rawBody)>; signature is
// base64(HMAC-SHA1(authToken, URL)) over the FULL URL with NO form params.
function signedJsonPost(
  app: express.Express,
  path: string,
  body: unknown,
  opts: { tamper?: boolean } = {},
): request.Test {
  const raw = JSON.stringify(body);
  const sha = createHash('sha256').update(raw, 'utf8').digest('hex');
  const pathWithSha = `${path}?bodySHA256=${sha}`;
  const signature = twilio.getExpectedTwilioSignature(AUTH_TOKEN, `${PUBLIC_BASE_URL}${pathWithSha}`, {});
  return request(app)
    .post(pathWithSha)
    .set('content-type', 'application/json')
    .set('x-twilio-signature', opts.tamper ? `${signature}TAMPERED` : signature)
    .send(raw);
}

describe('twilioJsonSignatureMiddleware', () => {
  it('accepts a correctly signed JSON post', async () => {
    const res = await signedJsonPost(makeApp(), '/hook', { transcript_sid: 'GTfake1' });
    expect(res.status).toBe(200);
  });

  it('rejects a tampered signature', async () => {
    const res = await signedJsonPost(makeApp(), '/hook', { transcript_sid: 'GTfake1' }, { tamper: true });
    expect(res.status).toBe(403);
  });

  it('rejects a body that does not match bodySHA256', async () => {
    const app = makeApp();
    const raw = JSON.stringify({ transcript_sid: 'GTfake1' });
    const sha = createHash('sha256').update('DIFFERENT', 'utf8').digest('hex');
    const url = `/hook?bodySHA256=${sha}`;
    const signature = twilio.getExpectedTwilioSignature(AUTH_TOKEN, `${PUBLIC_BASE_URL}${url}`, {});
    const res = await request(app)
      .post(url)
      .set('content-type', 'application/json')
      .set('x-twilio-signature', signature)
      .send(raw);
    expect(res.status).toBe(403);
  });

  it('rejects a missing signature header', async () => {
    const res = await request(makeApp())
      .post('/hook')
      .set('content-type', 'application/json')
      .send(JSON.stringify({ a: 1 }));
    expect(res.status).toBe(403);
  });

  it('unconfigured (no auth token / base URL) fails closed in production (403)', async () => {
    const app = makeApp({ authToken: undefined, publicBaseUrl: undefined, nodeEnv: 'production' });
    const res = await request(app)
      .post('/hook')
      .set('content-type', 'application/json')
      .send(JSON.stringify({ a: 1 }));
    expect(res.status).toBe(403);
  });

  it('unconfigured in development passes through (200)', async () => {
    const app = makeApp({ authToken: undefined, publicBaseUrl: undefined, nodeEnv: 'development' });
    const res = await request(app)
      .post('/hook')
      .set('content-type', 'application/json')
      .send(JSON.stringify({ a: 1 }));
    expect(res.status).toBe(200);
  });
});
