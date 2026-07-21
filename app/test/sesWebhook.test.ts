// email-channel B4: the dev-gated SES inbound webhook route (routes/webhooks/ses.ts)
// + its CONDITIONAL mount in the webhooks router. Contract:
//   - Mounted ONLY when config.sesApiBaseUrl is set (dev/e2e). Prod inbound is
//     SQS-only; the mount's prod-safety rests on the A3 SES_API_BASE_URL boot
//     throw + the x-origin-verify middleware (F15). Without sesApiBaseUrl the
//     path 404s (falls through to the webhooks 404 seam).
//   - m6 belt+braces (phaseA adjudication): the HANDLER ALSO refuses 404 when
//     config.nodeEnv === 'production', even if somehow mounted.
//   - Malformed SNS -> 200 ignored (never 5xx -> no SNS retry loop).
import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createSesWebhookRouter } from '../src/routes/webhooks/ses.js';
import { createWebhooksRouter } from '../src/routes/webhooks/index.js';
import { loadConfig, type AppConfig } from '../src/lib/config.js';
import type { InboundEmailNotice, IngestResult } from '../src/services/inboundEmail.js';

const cfgWithSes = loadConfig({
  NODE_ENV: 'test',
  CF_ORIGIN_SECRET: 's',
  SES_API_BASE_URL: 'http://127.0.0.1:9999',
});
const cfgWithoutSes = loadConfig({ NODE_ENV: 'test', CF_ORIGIN_SECRET: 's' });

function inboundSnsBody(): object {
  return {
    Type: 'Notification',
    Message: JSON.stringify({
      notificationType: 'Received',
      receipt: {
        action: { type: 'S3', bucketName: 'hc-inbound', objectKey: 'inbound/1.eml' },
        spamVerdict: { status: 'PASS' },
        virusVerdict: { status: 'PASS' },
      },
      mail: { messageId: 'ses-recv-1' },
    }),
  };
}

function eventSnsBody(): object {
  return {
    Type: 'Notification',
    Message: JSON.stringify({ eventType: 'Delivery', mail: { messageId: 'ses-out-1' }, delivery: {} }),
  };
}

/** A bare express app mounting the router under test with the JSON body parser. */
function mountSes(config: AppConfig, over: Parameters<typeof createSesWebhookRouter>[0] = {}) {
  const app = express();
  app.use(express.json());
  app.use('/webhooks/ses', createSesWebhookRouter({ config, ...over }));
  return app;
}

describe('createSesWebhookRouter POST /webhooks/ses/inbound', () => {
  it('ingests an inbound SNS notification and returns 200 { outcome }', async () => {
    const ingest = vi.fn(
      async (notice: InboundEmailNotice): Promise<IngestResult> => {
        expect(notice).toEqual({ bucket: 'hc-inbound', key: 'inbound/1.eml', spamVerdict: 'PASS', virusVerdict: 'PASS' });
        return { outcome: 'threaded', conversationId: 'conv-1', tsMsgId: 'ts#1' };
      },
    );
    const res = await request(mountSes(cfgWithSes, { ingest })).post('/webhooks/ses/inbound').send(inboundSnsBody());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ outcome: 'threaded', conversationId: 'conv-1' });
    expect(ingest).toHaveBeenCalledTimes(1);
  });

  it('routes an event notification to applyEmailEvent and returns 200 { ok: true }', async () => {
    const applyEmailEvent = vi.fn(async () => {});
    const ingest = vi.fn(async (): Promise<IngestResult> => ({ outcome: 'threaded' }));
    const res = await request(mountSes(cfgWithSes, { ingest, applyEmailEvent }))
      .post('/webhooks/ses/inbound')
      .send(eventSnsBody());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, outcome: 'event' });
    expect(applyEmailEvent).toHaveBeenCalledTimes(1);
    expect(ingest).not.toHaveBeenCalled();
  });

  it('answers 200 ignored for a malformed SNS body (never 5xx / retry loop)', async () => {
    const ingest = vi.fn(async (): Promise<IngestResult> => ({ outcome: 'threaded' }));
    const res = await request(mountSes(cfgWithSes, { ingest }))
      .post('/webhooks/ses/inbound')
      .send({ Type: 'Notification', Message: 'not-json{' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, outcome: 'ignored' });
    expect(ingest).not.toHaveBeenCalled();
  });

  it('refuses with 404 when config.nodeEnv === production (m6 belt+braces)', async () => {
    const ingest = vi.fn(async (): Promise<IngestResult> => ({ outcome: 'threaded' }));
    const prodConfig: AppConfig = { ...cfgWithSes, nodeEnv: 'production' };
    const res = await request(mountSes(prodConfig, { ingest })).post('/webhooks/ses/inbound').send(inboundSnsBody());
    expect(res.status).toBe(404);
    expect(ingest).not.toHaveBeenCalled();
  });

  it('answers 503 for an inbound notification when the raw store is unconfigured (no ingest)', async () => {
    // No ingest injected + a config with no INBOUND_MAIL_BUCKET -> ingest is
    // undefined -> the stored raw MIME is unreachable.
    const res = await request(mountSes(cfgWithSes)).post('/webhooks/ses/inbound').send(inboundSnsBody());
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: 'email_ingest_unavailable' });
  });
});

describe('createWebhooksRouter - conditional SES mount (F15)', () => {
  it('mounts /webhooks/ses/inbound when sesApiBaseUrl is set', async () => {
    const ingest = vi.fn(async (): Promise<IngestResult> => ({ outcome: 'unmatched', unmatchedId: 'um-1' }));
    const app = express();
    app.use(express.json());
    app.use('/webhooks', createWebhooksRouter({ config: cfgWithSes, ingest }));
    const res = await request(app).post('/webhooks/ses/inbound').send(inboundSnsBody());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ outcome: 'unmatched', unmatchedId: 'um-1' });
  });

  it('does NOT mount the SES route when sesApiBaseUrl is unset (404 seam)', async () => {
    const app = express();
    app.use(express.json());
    app.use('/webhooks', createWebhooksRouter({ config: cfgWithoutSes }));
    const res = await request(app).post('/webhooks/ses/inbound').send(inboundSnsBody());
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'not implemented' });
  });
});
