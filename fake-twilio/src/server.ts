import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type Express } from 'express';
import type { FakeTwilioConfig } from './config.js';
import { FakeTwilioEngine } from './engine/engine.js';
import { CallEngine } from './engine/callEngine.js';
import { MailEngine } from './engine/mailEngine.js';
import { NumberRegistry } from './engine/numberRegistry.js';
import { EventHub } from './engine/eventHub.js';
import { RealClock } from './engine/clock.js';
import { WebhookDispatcher } from './engine/dispatcher.js';
import { createRestRouter } from './routes/rest.js';
import { createVoiceRestRouter } from './routes/voiceRest.js';
import { createIntelligenceRestRouter } from './routes/intelligenceRest.js';
import { createControlRouter } from './routes/control.js';
import { createVoiceControlRouter } from './routes/voiceControl.js';
import { createSesRestRouter } from './routes/sesRest.js';
import { createSesControlRouter } from './routes/sesControl.js';
import { createRcsRouter } from './routes/rcs.js';
import { createEventsRouter } from './routes/events.js';

/** Absolute path to the committed canned recording MP3 the serve route streams.
 *  Resolved relative to THIS module via import.meta.url (not cwd) so it works under
 *  tsx and vitest, which both run this service directly from src/. There is no dist
 *  build/copy step for the fake-twilio backend — it always executes from src/
 *  (dev + e2e + tests), so `./assets/...` next to src/server.ts is the only target. */
const CANNED_RECORDING_PATH = fileURLToPath(new URL('./assets/canned-recording.mp3', import.meta.url));

export interface FakeTwilioAppDeps {
  config: FakeTwilioConfig;
  /** The shared event bus the engine emits through and the SSE route subscribes to.
   *  Injectable for tests; defaults to a fresh hub. When `engine` is also injected,
   *  pass the SAME hub it was constructed with so the SSE stream sees its events. */
  hub?: EventHub;
  /** Injectable for tests; defaults to a real-clock engine with a real dispatcher. */
  engine?: FakeTwilioEngine;
  /** The voice CallEngine (Phase 6 click-to-call + recording). Injectable for tests;
   *  default-constructed sharing the messaging engine's hub + a real clock/dispatcher. */
  callEngine?: CallEngine;
  /** The shared pool-number registry (number provisioning + masked-vs-founder routing).
   *  ONE instance is shared by the CallEngine and the voice REST router so a number
   *  provisioned via REST is recognized as a pool number by an inbound call. */
  registry?: NumberRegistry;
  /** The fake-SES MailEngine (email-channel v1). Injectable for tests; default-
   *  constructed sharing the messaging engine's hub so its `mail.outbound` events
   *  reach the SSE stream. */
  mailEngine?: MailEngine;
}

export function buildFakeTwilioApp(deps: FakeTwilioAppDeps): Express {
  // Defense in depth: refuse to construct the fake locally if NODE_ENV=production,
  // independent of the loadFakeConfig guard — it impersonates Twilio and must never
  // run in a deployed environment.
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'fake-twilio refuses to start while NODE_ENV=production — it impersonates Twilio and must ' +
        'never run in a deployed environment.',
    );
  }

  // One shared event bus per process: the engine(s) emit through it and the SSE
  // events route subscribes to it. The Phase 5 CallEngine will share this same hub.
  const hub = deps.hub ?? new EventHub();

  // One engine per process — shared by the REST router (here) and, in a later
  // phase, the control router. Construct it once and pass it to every router.
  const engine =
    deps.engine ??
    new FakeTwilioEngine({
      clock: new RealClock(),
      hub,
      dispatcher: new WebhookDispatcher({
        appBaseUrl: deps.config.appBaseUrl,
        appPublicBaseUrl: deps.config.appPublicBaseUrl,
        authToken: deps.config.authToken,
        // The app's origin-secret validator gates /webhooks/* (it runs BEFORE the
        // webhook routes in the locked chain), so signed webhook POSTs also need
        // the x-origin-verify header — pass the configured secret through.
        originSecret: deps.config.originSecret,
      }),
    });

  // ONE pool-number registry shared by the CallEngine (isPool → masked-vs-founder
  // routing) and the voice REST router (number provisioning) — a number purchased
  // via IncomingPhoneNumbers.json is then recognized as a pool number by an inbound
  // masked call. Injectable for tests.
  const registry = deps.registry ?? new NumberRegistry();

  // The voice CallEngine — shares the messaging engine's SAME hub (so the SSE stream
  // sees call events too), the registry above, a real clock + a webhook dispatcher.
  // recordingServeBase is the fake's OWN public origin (config.publicBaseUrl), which
  // is exactly the app's TWILIO_API_BASE_URL origin — so the recording URLs it mints
  // (`${publicBaseUrl}/recordings/...`) point back at THIS host's serve route AND
  // pass the app's Phase-1 SSRF dev-override (url.origin === twilioApiBaseUrl origin).
  const callEngine =
    deps.callEngine ??
    new CallEngine({
      clock: new RealClock(),
      dispatcher: new WebhookDispatcher({
        appBaseUrl: deps.config.appBaseUrl,
        appPublicBaseUrl: deps.config.appPublicBaseUrl,
        authToken: deps.config.authToken,
        originSecret: deps.config.originSecret,
      }),
      hub: engine.hub,
      registry,
      recordingServeBase: deps.config.publicBaseUrl,
    });

  // The fake-SES MailEngine - shares the SAME hub (so its `mail.outbound` events
  // reach the SSE stream by construction, like the CallEngine above). It captures
  // the app's outbound SESv2 SendEmail and stores the raw MIME in memory. The
  // INBOUND path (email-channel B4) writes to MinIO INBOUND_MAIL_BUCKET and POSTs
  // an SNS-shaped receipt to the app's /webhooks/ses/inbound - so it needs the
  // app's address, the origin secret, the inbound bucket, and the MinIO endpoint
  // (all from the SAME childEnv the app/worker inherit).
  const mailEngine =
    deps.mailEngine ??
    new MailEngine({
      hub: engine.hub,
      inbound: {
        appBaseUrl: deps.config.appBaseUrl,
        originSecret: deps.config.originSecret,
        ...(deps.config.inboundMailBucket !== undefined && { bucket: deps.config.inboundMailBucket }),
        ...(deps.config.mediaS3Endpoint !== undefined && { s3Endpoint: deps.config.mediaS3Endpoint }),
      },
    });

  const app = express();
  // Twilio posts application/x-www-form-urlencoded; the control API uses JSON.
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());

  app.get('/health', (_req, res) => {
    res.status(200).json({ ok: true, service: 'fake-twilio' });
  });

  app.use(createRestRouter(engine));
  // Voice REST surface (Calls.json, AvailablePhoneNumbers, IncomingPhoneNumbers) +
  // the recording-serve route — replaces the former 501 stubs in createRestRouter.
  app.use(createVoiceRestRouter({ callEngine, registry, cannedRecordingPath: CANNED_RECORDING_PATH }));
  // Voice Intelligence REST surface (POST /v2/Transcripts + fetch/sentences) the app's
  // twilio client hits for transcription; a create schedules the signed JSON webhook.
  app.use(createIntelligenceRestRouter({ callEngine, serviceSid: deps.config.viServiceSid }));
  // The control router mounts here with the same `engine` instance.
  app.use(createControlRouter(engine));
  // The VOICE control router shares the `/control` prefix but owns DISJOINT
  // subpaths (`/control/place-call`, `/control/calls[...]`) — no collision with
  // the SMS control routes above. It drives the SAME CallEngine instance built
  // (or injected) here, so a call placed via control is the one the voice REST
  // surface + SSE stream see.
  app.use(createVoiceControlRouter({ callEngine }));
  // RCS 501 seams (Task 7.2): the Content-API REST path + POST /control/send-rcs
  // both 501 with a pointer to docs/RCS-integration-contract.md. Thin — no engine.
  app.use(createRcsRouter());
  // fake-SES (email-channel v1): the SESv2 SendEmail REST surface (POST
  // /v2/email/outbound-emails) + the disjoint mail CONTROL subpaths (/control/emails,
  // /control/reset-mail). Both driven by the SAME mailEngine; mounted BEFORE the SSE
  // + static-UI blocks so the reserved-prefix guard (/v2, /control) matches them.
  app.use(createSesRestRouter(mailEngine));
  app.use(createSesControlRouter(mailEngine));
  // SSE stream of engine events for the fake-phones UI (Plan 2). Derive the hub from
  // the (injected-or-constructed) engine so the SSE stream is ALWAYS the bus the engine
  // emits through — no way to fabricate a mismatched hub even when `engine` is injected
  // without `hub`. (Phase 7's CallEngine shares this same `engine.hub`.)
  app.use(createEventsRouter(engine.hub));

  // Static-serve the built fake-phones UI + SPA fallback, AFTER all API routers so
  // reserved prefixes are matched by their routers first; the fallback only catches
  // the remainder. Inert when uiDistDir is unset (no UI in plain test/scripted runs).
  if (deps.config.uiDistDir) {
    const distDir = path.resolve(deps.config.uiDistDir);
    const csp = [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "connect-src 'self'",
      "frame-ancestors 'none'",
    ].join('; ');
    app.use((_req, res, next) => {
      res.setHeader('Content-Security-Policy', csp);
      res.setHeader('X-Frame-Options', 'DENY');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      next();
    });
    app.use(express.static(distDir));
    app.use((req, res, next) => {
      const reserved = ['/control', '/health', '/2010-04-01', '/webhooks', '/recordings', '/v1', '/v2'].some(
        (p) => req.path === p || req.path.startsWith(`${p}/`),
      );
      if ((req.method !== 'GET' && req.method !== 'HEAD') || reserved) {
        next();
        return;
      }
      res.sendFile(path.join(distDir, 'index.html'), (err) => {
        if (err) next(err);
      });
    });
  }

  return app;
}
