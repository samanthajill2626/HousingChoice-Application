// Change Order 3 — custom domain + TLS cutover regressions.
//
// The cert + alias are Terraform (not exercisable here), but the CUTOVER hinges
// on the app being host-agnostic: every absolute URL and origin check derives
// from PUBLIC_BASE_URL, so flipping it to the custom domain (custom_domain_phase
// 2) must keep OAuth, Twilio signature verification, and the CSRF origin gate
// working — against the NEW host, and only the new host. These lock that in so a
// future refactor can't silently break the cutover. The live TLS-handshake /
// cert-CN / alias-only-serving checks live in RUNBOOK "Custom domain & TLS".
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/lib/config.js';
import { callbackRedirectUri } from '../src/routes/auth.js';
import {
  inboundSmsParams,
  makeWebhookHarness,
  ORIGIN_SECRET,
  PUBLIC_BASE_URL as CLOUDFRONT_BASE_URL,
  signedTwilioPost,
} from './helpers/twilioWebhookHarness.js';
import { TEST_SESSION_COOKIE } from './helpers/authSession.js';

// The post-cutover canonical host (matches infra dev locals custom_domain).
const CUSTOM_DOMAIN = 'https://dev.app.housingchoice.org';

// --- OAuth callback URL tracks PUBLIC_BASE_URL --------------------------------

describe('OAuth callback redirect URI on the custom domain', () => {
  it('builds the callback from the configured PUBLIC_BASE_URL (custom domain)', () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      CF_ORIGIN_SECRET: 'x',
      PUBLIC_BASE_URL: CUSTOM_DOMAIN,
    } as NodeJS.ProcessEnv);
    expect(callbackRedirectUri(config)).toBe(`${CUSTOM_DOMAIN}/auth/callback`);
  });

  it('tolerates a trailing slash on PUBLIC_BASE_URL (no double slash)', () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      CF_ORIGIN_SECRET: 'x',
      PUBLIC_BASE_URL: `${CUSTOM_DOMAIN}/`,
    } as NodeJS.ProcessEnv);
    expect(callbackRedirectUri(config)).toBe(`${CUSTOM_DOMAIN}/auth/callback`);
  });
});

// --- Twilio webhook signature is host-agnostic (reconstructs from config) -----

describe('Twilio webhook signature verifies via the custom domain', () => {
  it('ACCEPTS a webhook signed against the configured custom-domain host', async () => {
    const { app } = makeWebhookHarness({ env: { PUBLIC_BASE_URL: CUSTOM_DOMAIN } });
    const res = await signedTwilioPost(app, '/webhooks/twilio/sms', inboundSmsParams(), {
      signatureBaseUrl: CUSTOM_DOMAIN,
    });
    // 403 is the signature-rejection status — a valid signature must not get it.
    expect(res.status).not.toBe(403);
  });

  it('REJECTS a webhook signed against the OLD CloudFront host once cut over (proves the URL is reconstructed from config, not the Host header)', async () => {
    const { app, capture } = makeWebhookHarness({ env: { PUBLIC_BASE_URL: CUSTOM_DOMAIN } });
    const res = await signedTwilioPost(app, '/webhooks/twilio/sms', inboundSmsParams(), {
      signatureBaseUrl: CLOUDFRONT_BASE_URL,
    });
    expect(res.status).toBe(403);
    const warn = capture
      .atLevel(40)
      .find((l) => String(l['msg']).includes('invalid X-Twilio-Signature'));
    expect(warn).toBeDefined();
  });
});

// --- CSRF origin gate tracks the cut-over host --------------------------------

describe('CSRF origin gate after the custom-domain cutover', () => {
  async function authedHarness() {
    const harness = makeWebhookHarness({ env: { PUBLIC_BASE_URL: CUSTOM_DOMAIN } });
    const conv = await harness.world.conversationsRepo.createOrGetByParticipantPhone(
      '+15550100099',
      'tenant_1to1',
    );
    return { app: harness.app, readPath: `/api/conversations/${conv.conversationId}/read` };
  }

  it('ACCEPTS a same-origin POST from the custom domain', async () => {
    const { app, readPath } = await authedHarness();
    const res = await request(app)
      .post(readPath)
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .set('origin', CUSTOM_DOMAIN);
    expect(res.status).toBe(200);
  });

  it('REJECTS the now-stale CloudFront origin (single-origin by design — old host stops mutating post-cutover)', async () => {
    const { app, readPath } = await authedHarness();
    const res = await request(app)
      .post(readPath)
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .set('origin', CLOUDFRONT_BASE_URL);
    expect(res.status).toBe(403);
  });
});
