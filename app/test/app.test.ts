// Acceptance tests 3, 4 and 5 (M0.2):
//   3. origin-secret middleware: 403 without/with-wrong header, body never
//      parsed for rejected requests, WARN log with offender IP + path +
//      correlationId; correct header reaches the route.
//   4. GET /health bypasses the origin-secret check (path-based exemption).
//   5. expressErrorHandler logs stack + correlationId and returns 500.
import type { Express } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/lib/config.js';
import { createLogger } from '../src/lib/logger.js';
import { createLogCapture, type LogCapture } from './helpers/logCapture.js';

const SECRET = 'test-origin-secret';
const WARN = 40;
const ERROR = 50;

describe('buildApp', () => {
  let app: Express;
  let capture: LogCapture;
  let echoReached: boolean;

  beforeEach(() => {
    capture = createLogCapture();
    echoReached = false;
    const config = loadConfig({ NODE_ENV: 'test', CF_ORIGIN_SECRET: SECRET });
    app = buildApp({
      config,
      logger: createLogger({ level: 'info', destination: capture.stream }),
      configureRoutes: (a) => {
        a.post('/echo', (req, res) => {
          echoReached = true;
          res.json({ body: req.body as unknown });
        });
        a.get('/boom', () => {
          throw new Error('kaboom');
        });
      },
    });
  });

  describe('origin-secret middleware (acceptance 3)', () => {
    it('rejects requests WITHOUT x-origin-verify with 403, never parses the body, and WARN-logs IP + path + correlationId', async () => {
      const res = await request(app)
        .post('/echo')
        .set('content-type', 'application/json')
        .send({ secretPayload: true });

      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: 'forbidden' });
      expect(echoReached).toBe(false); // body parser + route never ran

      const warns = capture.atLevel(WARN);
      expect(warns).toHaveLength(1);
      const warn = warns[0]!;
      expect(warn['path']).toBe('/echo');
      expect(typeof warn['remoteIp']).toBe('string');
      expect((warn['remoteIp'] as string).length).toBeGreaterThan(0);
      expect(typeof warn['correlationId']).toBe('string');
      expect(warn['correlationId']).toBe(warn['requestId']);
    });

    it('rejects a WRONG x-origin-verify value with 403', async () => {
      const res = await request(app)
        .post('/echo')
        .set('x-origin-verify', 'wrong-value')
        .send({ a: 1 });

      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: 'forbidden' });
      expect(echoReached).toBe(false);
      // the WARN line must never contain the offered secret value
      const warn = capture.atLevel(WARN)[0]!;
      expect(JSON.stringify(warn)).not.toContain('wrong-value');
    });

    it('passes requests WITH the correct header through to the route, body parsed', async () => {
      const res = await request(app)
        .post('/echo')
        .set('x-origin-verify', SECRET)
        .send({ hello: 'world' });

      expect(res.status).toBe(200);
      expect(echoReached).toBe(true);
      expect(res.body).toEqual({ body: { hello: 'world' } });
    });
  });

  describe('/health bypass (acceptance 4)', () => {
    it('GET /health with NO origin header returns 200 even though CF_ORIGIN_SECRET is set (path-based exemption)', async () => {
      const res = await request(app).get('/health');

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ status: 'ok', service: 'app' });
      expect(typeof res.body.uptimeSeconds).toBe('number');
      expect(typeof res.body.version).toBe('string');
      // no rejection was logged
      expect(capture.atLevel(WARN)).toHaveLength(0);
    });
  });

  describe('expressErrorHandler (acceptance 5)', () => {
    it('logs stack + correlationId and returns 500 for a throwing route', async () => {
      const res = await request(app).get('/boom').set('x-origin-verify', SECRET);

      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: 'internal server error' });

      const errors = capture.atLevel(ERROR);
      expect(errors).toHaveLength(1);
      const line = errors[0]!;
      const err = line['err'] as Record<string, unknown>;
      expect(err['message']).toBe('kaboom');
      expect(String(err['stack'])).toContain('kaboom');
      expect(typeof line['correlationId']).toBe('string');
    });
  });

  describe('security headers (route stage)', () => {
    it('responses carry X-Content-Type-Options: nosniff — health, routes and 500s alike', async () => {
      expect((await request(app).get('/health')).headers['x-content-type-options']).toBe('nosniff');

      const echoed = await request(app).post('/echo').set('x-origin-verify', SECRET).send({ a: 1 });
      expect(echoed.status).toBe(200);
      expect(echoed.headers['x-content-type-options']).toBe('nosniff');

      // Errors too: the header is on the response before the route throws.
      const boom = await request(app).get('/boom').set('x-origin-verify', SECRET);
      expect(boom.status).toBe(500);
      expect(boom.headers['x-content-type-options']).toBe('nosniff');
    });
  });

  describe('correlation + webhooks seam', () => {
    it('sets x-request-id on responses and the request log carries the same correlationId', async () => {
      const res = await request(app).get('/health');
      const requestId = res.headers['x-request-id'];
      expect(typeof requestId).toBe('string');
      const requestLine = capture.lines.find((l) => l['msg'] === 'request received')!;
      expect(requestLine['correlationId']).toBe(requestId);
      expect(requestLine['xffTrust']).toBe('untrusted-until-validated');
    });

    it('webhooks router is a 404 seam (with origin secret)', async () => {
      const res = await request(app)
        .post('/webhooks/twilio')
        .set('x-origin-verify', SECRET)
        .send({});
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'not implemented' });
    });
  });
});

describe('config fail-fast', () => {
  it('throws when CF_ORIGIN_SECRET is missing in production', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(/CF_ORIGIN_SECRET/);
  });

  it('allows a dev default locally', () => {
    const config = loadConfig({ NODE_ENV: 'development' });
    expect(config.cfOriginSecret.length).toBeGreaterThan(0);
    expect(config.port).toBe(8080);
  });

  describe('job-delivery wiring (M1.2)', () => {
    // Production-shaped base that clears every OTHER fail-fast gate.
    const prodBase = { NODE_ENV: 'production', CF_ORIGIN_SECRET: 's', MESSAGING_DRIVER: 'console' };
    const jobDelivery = {
      JOBS_QUEUE_URL: 'https://sqs.us-east-1.amazonaws.com/000000000000/hc-test-jobs',
      SCHEDULER_TARGET_ARN: 'arn:aws:sqs:us-east-1:000000000000:hc-test-jobs',
      SCHEDULER_ROLE_ARN: 'arn:aws:iam::000000000000:role/hc-test-scheduler',
    };

    it('production throws when ANY of JOBS_QUEUE_URL / SCHEDULER_TARGET_ARN / SCHEDULER_ROLE_ARN is missing', () => {
      expect(() => loadConfig(prodBase)).toThrow(/JOBS_QUEUE_URL.*SCHEDULER_TARGET_ARN.*SCHEDULER_ROLE_ARN/);
      for (const missing of Object.keys(jobDelivery)) {
        const env = { ...prodBase, ...jobDelivery, [missing]: undefined };
        expect(() => loadConfig(env), missing).toThrow(new RegExp(missing));
      }
    });

    // M1.3 auth wiring — required in production alongside the job delivery.
    const authWiring = {
      SESSION_SECRET: 'test-session-secret',
      GOOGLE_CLIENT_ID: 'cid.apps.googleusercontent.com',
      GOOGLE_CLIENT_SECRET: 'test-google-client-secret',
      OAUTH_ALLOWED_DOMAINS: 'housingchoice.org,abt-industries.com',
    };

    it('production boots with the full wiring; local NODE_ENVs keep the in-memory path (no throw)', () => {
      const config = loadConfig({ ...prodBase, ...jobDelivery, ...authWiring });
      expect(config.jobsQueueUrl).toBe(jobDelivery.JOBS_QUEUE_URL);
      expect(config.schedulerTargetArn).toBe(jobDelivery.SCHEDULER_TARGET_ARN);
      expect(config.schedulerRoleArn).toBe(jobDelivery.SCHEDULER_ROLE_ARN);

      // development/test without any wiring still boot (WARN + in-memory).
      expect(loadConfig({ NODE_ENV: 'development' }).jobsQueueUrl).toBeUndefined();
      expect(loadConfig({ NODE_ENV: 'test' }).schedulerTargetArn).toBeUndefined();
    });
  });
});
