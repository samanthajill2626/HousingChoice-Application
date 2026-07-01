// M1.9b (Change Order 2) golden suite: founder CALL-TRIAGE — an inbound call to
// a BUSINESS number (not a pool number). The pre-ring push to the founder (admin
// user) ~2s AHEAD of the ring, the bridge to the founder's cell with the
// BUSINESS number as caller ID (never the real caller's From) behind the same
// whisper + press-1 gate, and — on a MISSED call — the missed-call push + the
// zero-tap auto-text (idempotent per CallSid). Driven through the REAL app
// (buildApp) + the webhook harness with REAL computed X-Twilio-Signature values
// and the jobs machinery wired so the auto-text fans out in-process end-to-end.
//
// GUARDRAILS asserted here (the M1.9b contract):
//  - founder-leg callerId is ALWAYS the business number, NEVER the caller's From
//  - the pre-ring push is sent BEFORE the <Dial>, and the TwiML has the <Pause>
//    so it lands ~2s ahead of the ring
//  - no raw caller phone/name in any push payload or log line (masked label only)
//  - auto-text fires EXACTLY ONCE per missed call (CallSid marker)
//  - auto-text respects the settings toggle + opt-out (SendRefusedError skipped)
//  - the founder-bridge RECORDS (M1.9c / CO1) — record-from-answer-dual +
//    recordingStatusCallback (the masked relay stays do-not-record)
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  InMemorySchedulerAdapter,
  InProcessOutboundQueueAdapter,
} from '../src/adapters/scheduler.js';
import {
  _resetForTests,
  configureJobsLogger,
  configureOutboundQueue,
  configureScheduler,
  dispatchJob,
} from '../src/jobs/jobs.js';
import { registerMissedCallAutoTextJobHandler } from '../src/jobs/missedCallAutoText.js';
import { createLogger } from '../src/lib/logger.js';
import { createSendMessageService } from '../src/services/sendMessage.js';
import type { PushService, SendToUserResult } from '../src/services/pushService.js';
import {
  createFakeWorld,
  makeWebhookHarness,
  signedTwilioPost,
  OUR_NUMBER,
  type FakeWorld,
} from './helpers/twilioWebhookHarness.js';
import { TEST_ADMIN_USER } from './helpers/authSession.js';
import { createLogCapture } from './helpers/logCapture.js';

const CALLER = '+15550177777'; // a tenant calling the business number
// The inbound-voice-line HOLDER's verified cell — the number inbound calls ring.
// (Named FOUNDER_CELL for continuity with this legacy suite; it is now purely the
// holder's cell, NOT an env var — there is no env-var fallback anymore.)
const FOUNDER_CELL = '+15550160000';

/** A standard inbound voice webhook to the BUSINESS number (non-pool To). */
function bizVoiceParams(over: Record<string, string> = {}): Record<string, string> {
  return {
    CallSid: 'CAbiz0001',
    AccountSid: 'ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    From: CALLER,
    To: OUR_NUMBER,
    CallStatus: 'ringing',
    Direction: 'inbound',
    ApiVersion: '2010-04-01',
    ...over,
  };
}

/**
 * Build a harness with the inbound bridge wired. Voice Phase 1 (spec §6): the
 * dialed cell + pre-ring push come from the INBOUND-VOICE-LINE HOLDER's verified
 * cell (there is NO env-var fallback). So we assign the seeded ADMIN user as the
 * holder with a verified cell == FOUNDER_CELL — the dialed cell is that holder's
 * cell and the pre-ring push targets the admin. No-holder behavior is covered by
 * the dedicated "no verified holder" test below.
 */
function founderHarness(world: FakeWorld) {
  const harness = makeWebhookHarness({ world });
  const admin = harness.fakeUsers.users.get(TEST_ADMIN_USER.userId);
  if (admin) {
    admin.cell = FOUNDER_CELL;
    admin.cell_verified_at = '2026-07-01T00:00:00.000Z';
    // Establish the holder via the authoritative pointer. The fake's assign sets
    // its in-memory pointer SYNCHRONOUSLY (no awaited work before the write), so
    // this fire-and-forget call is settled before the harness is used.
    void harness.fakeUsers.repo.assignInboundVoiceLine(admin.userId);
  }
  return harness;
}

describe('founder call-triage — the inbound bridge (M1.9b)', () => {
  it('To=business number → pre-ring push to the founder (admin), then <Pause>+<Dial> the founder cell from the business number', async () => {
    const world = createFakeWorld();
    // Type the caller as a tenant so the masked label resolves to the role+name.
    world.contacts.push({
      contactId: 'c-caller',
      type: 'tenant',
      phone: CALLER,
      firstName: 'Jane',
      lastName: 'Doe',
    });
    const { app } = founderHarness(world);

    const res = await signedTwilioPost(app, '/webhooks/twilio/voice', bizVoiceParams());
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/xml');
    const xml = res.text;

    // GUARDRAIL: callerId is the BUSINESS number, never the caller's From.
    expect(xml).toContain(`callerId="${OUR_NUMBER}"`);
    expect(xml).not.toContain(CALLER);
    // GUARDRAIL: the <Pause> precedes the <Dial> so the push lands first.
    const pauseIdx = xml.indexOf('<Pause');
    const dialIdx = xml.indexOf('<Dial');
    expect(pauseIdx).toBeGreaterThanOrEqual(0);
    expect(dialIdx).toBeGreaterThan(pauseIdx);
    // Bridges to the FOUNDER CELL behind the whisper + press-1 gate.
    expect(xml).toContain(FOUNDER_CELL);
    expect(xml).toContain('/webhooks/twilio/voice/whisper');
    expect(xml).toContain('leg=founder');
    // M1.9c (CO1): the founder bridge RECORDS (the masked relay stays
    // do-not-record — asserted in voiceWebhook.test.ts). recording-from-answer
    // + the recordingStatusCallback drive the S3 mirror.
    expect(xml).not.toContain('record="do-not-record"');
    expect(xml).toContain('record="record-from-answer-dual"');
    expect(xml).toContain('/webhooks/twilio/voice/recording');
    // The dial reports completion to the status route.
    expect(xml).toContain('/webhooks/twilio/voice/status');

    // Pre-ring push sent to the founder (admin) BEFORE the dial, masked body.
    expect(world.pushSends).toHaveLength(1);
    const push = world.pushSends[0]!;
    expect(push.userId).toBe(TEST_ADMIN_USER.userId);
    expect(push.notification.kind).toBe('pre_ring');
    expect(push.notification.payload.kind).toBe('pre_ring');
    expect(push.notification.payload.callId).toBe('CAbiz0001');
    // Masked: the role + abbreviated name, NEVER the raw phone.
    expect(push.notification.payload.body).toBe('Incoming call — Tenant (Jane D.)');
    expect(JSON.stringify(push.notification.payload)).not.toContain(CALLER);
  });

  it('the <Pause length> comes from the founder-editable OrgSettings preRingPauseSeconds', async () => {
    const world = createFakeWorld();
    // Founder edited the pause to 5s via the Settings panel (DB-backed setting).
    world.settings.preRingPauseSeconds = 5;
    const { app } = founderHarness(world);

    const res = await signedTwilioPost(app, '/webhooks/twilio/voice', bizVoiceParams());
    expect(res.status).toBe(200);
    // The TwiML <Pause> reflects the setting, NOT a config/env value.
    expect(res.text).toContain('<Pause length="5"');
  });

  it('defaults the <Pause length> to 2 when the setting is somehow invalid (defensive clamp)', async () => {
    const world = createFakeWorld();
    // A malformed stored value (e.g. a hand-edited DynamoDB item) must not break
    // the bridge — the handler clamps back to the 2s default.
    (world.settings as { preRingPauseSeconds: number }).preRingPauseSeconds = -3;
    const { app } = founderHarness(world);

    const res = await signedTwilioPost(app, '/webhooks/twilio/voice', bizVoiceParams());
    expect(res.status).toBe(200);
    expect(res.text).toContain('<Pause length="2"');
  });

  it('persists a NON-masked founder-bridge call entry (CallSid-idempotent, masked label, no recording fields)', async () => {
    const world = createFakeWorld();
    world.contacts.push({ contactId: 'c-caller', type: 'tenant', phone: CALLER, firstName: 'Jane', lastName: 'Doe' });
    const { app } = founderHarness(world);

    await signedTwilioPost(app, '/webhooks/twilio/voice', bizVoiceParams());

    const calls = world.messages.filter((m) => m.type === 'call');
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.direction).toBe('inbound');
    // GUARDRAIL: a founder-bridge is NOT a masked relay.
    expect(call.masked).not.toBe(true);
    expect(call.provider_sid).toBe('CAbiz0001');
    expect(call.call_status).toBe('ringing');
    expect(call.author).toBe('tenant'); // caller's reviewed role
    // call_party_label is the MASKED caller label — never a phone.
    expect(call.call_party_label).toBe('Tenant (Jane D.)');
    expect(call.call_party_label).not.toContain('+');
    // GUARDRAIL: the founder-bridge never populates recording/transcript (M1.9c).
    expect(call.recording_s3_key).toBeUndefined();
    expect(call.transcript).toBeUndefined();

    // CallSid idempotency: a redelivered /voice must NOT double-write the entry.
    await signedTwilioPost(app, '/webhooks/twilio/voice', bizVoiceParams());
    expect(world.messages.filter((m) => m.type === 'call')).toHaveLength(1);
  });

  it('an UNKNOWN caller → masked STORED label, but the pre-ring PUSH surfaces the caller number', async () => {
    const world = createFakeWorld();
    const { app, capture } = founderHarness(world);

    const res = await signedTwilioPost(app, '/webhooks/twilio/voice', bizVoiceParams());
    expect(res.status).toBe(200);

    const call = world.messages.find((m) => m.provider_sid === 'CAbiz0001')!;
    expect(call.author).toBe('unknown');
    // STORED on the call entity: still masked — the number never persists.
    expect(call.call_party_label).toBe('Unknown caller');

    // PUSH (founder's own device): surfaces the caller's FORMATTED number so an
    // unknown caller is triageable (CO2 item 5 only masks the DIAL leg, not the
    // push). CALLER = +15550177777 → "(555) 017-7777".
    const push = world.pushSends[0]!;
    expect(push.notification.payload.body).toBe('Incoming call — (555) 017-7777');

    // ...but the number stays OUT of the logs (PII, doc §9) — neither the raw
    // E.164 nor the formatted form appears in any log line.
    expect(JSON.stringify(capture.lines)).not.toContain(CALLER);
    expect(JSON.stringify(capture.lines)).not.toContain('017-7777');
  });

  it('emits message.persisted once for the new founder-bridge call entry', async () => {
    const world = createFakeWorld();
    const { app } = founderHarness(world);
    await signedTwilioPost(app, '/webhooks/twilio/voice', bizVoiceParams());
    expect(world.emitted.filter((e) => e.event === 'message.persisted')).toHaveLength(1);
  });

  it('never logs the caller phone on the triage path (PII, doc §9)', async () => {
    const world = createFakeWorld();
    world.contacts.push({ contactId: 'c-caller', type: 'tenant', phone: CALLER, firstName: 'Jane', lastName: 'Doe' });
    const { app, capture } = founderHarness(world);
    await signedTwilioPost(app, '/webhooks/twilio/voice', bizVoiceParams());
    expect(JSON.stringify(capture.lines)).not.toContain(CALLER);
  });

  it('SELF-CALL guard: caller IS the founder cell → greeting + hangup, no self-bridge, no call entry/push', async () => {
    const world = createFakeWorld();
    const { app } = founderHarness(world);
    // The inbound From is the founder's own cell (founder dialing the business
    // line, or a test from the founder phone).
    const res = await signedTwilioPost(app, '/webhooks/twilio/voice', bizVoiceParams({ From: FOUNDER_CELL }));
    expect(res.status).toBe(200);
    expect(res.text).not.toContain('<Dial'); // never bridges the founder to themselves
    expect(res.text).toContain('<Hangup');
    expect(res.text).toContain('different line');
    // No bogus call entry persisted, no pre-ring push fired.
    expect(world.messages.filter((m) => m.type === 'call')).toHaveLength(0);
    expect(world.pushSends).toHaveLength(0);
  });

  it('no verified inbound-voice-line holder → ERROR log + text-us greeting, NO bridge, NO push, NO leak', async () => {
    const world = createFakeWorld();
    // No holder assigned (and no env-var fallback exists) → cannot bridge. This is
    // an operator misconfiguration: the handler emits an ERROR (pino level 50 →
    // the error-logs alarm) and answers the caller with the text-us greeting.
    const { app, capture } = makeWebhookHarness({ world });

    const res = await signedTwilioPost(app, '/webhooks/twilio/voice', bizVoiceParams());
    expect(res.status).toBe(200); // never a 5xx (Twilio would retry forever)
    const xml = res.text;
    expect(xml).not.toContain('<Dial');
    expect(xml).toContain('<Hangup');
    expect(xml).toContain('send us a text message'); // the graceful text-us fallback
    expect(xml).not.toContain(CALLER);
    // No pre-ring push when we cannot bridge.
    expect(world.pushSends).toHaveLength(0);

    // The "we know" signal: an ERROR-level (50) log line naming the misconfig,
    // with the diagnostic booleans and NO raw phone number.
    const errors = capture.atLevel(50);
    const noHolder = errors.find((l) =>
      String(l['msg']).includes('NO inbound-voice-line holder with a verified cell'),
    );
    expect(noHolder, 'expected an ERROR log for the no-holder misconfig').toBeDefined();
    expect(noHolder!['hasBusinessNumber']).toBe(true);
    expect(noHolder!['hasVerifiedHolder']).toBe(false);
    expect(JSON.stringify(noHolder)).not.toContain(CALLER);
  });

  it('FIX 2: a SLOW (never-resolving) pre-ring push does NOT gate the bridge TwiML', async () => {
    const world = createFakeWorld();
    world.contacts.push({ contactId: 'c-caller', type: 'tenant', phone: CALLER, firstName: 'Jane', lastName: 'Doe' });
    // Replace the push service with one whose sendToUser NEVER resolves — a slow
    // push backend. If the handler awaited the push, the request would hang;
    // FIX 2 fires it without awaiting, so the bridge TwiML returns immediately.
    let pushStarted = false;
    const neverResolving: PushService = {
      // Params omitted (interface allows fewer): this stub only records that the
      // push was STARTED, then returns a promise that never settles.
      sendToUser(): Promise<SendToUserResult> {
        pushStarted = true;
        return new Promise<SendToUserResult>(() => {
          /* deliberately never resolves */
        });
      },
    };
    world.pushService = neverResolving;
    const harness = makeWebhookHarness({ world });
    const { app } = harness;
    // Voice Phase 1 (spec §6): the pre-ring push targets the inbound-voice-line
    // holder — assign the admin (verified cell == FOUNDER_CELL) so the push fires.
    const admin = harness.fakeUsers.users.get(TEST_ADMIN_USER.userId)!;
    admin.cell = FOUNDER_CELL;
    admin.cell_verified_at = '2026-07-01T00:00:00.000Z';
    await harness.fakeUsers.repo.assignInboundVoiceLine(admin.userId); // holder via pointer

    // The request resolves (does NOT hang on the push). A failure here would
    // surface as a test timeout rather than an assertion.
    const res = await signedTwilioPost(app, '/webhooks/twilio/voice', bizVoiceParams());
    expect(res.status).toBe(200);
    const xml = res.text;
    // The full bridge TwiML is present even though the push never completed.
    expect(xml).toContain('<Pause');
    expect(xml).toContain('<Dial');
    expect(xml).toContain(FOUNDER_CELL);
    expect(xml).toContain(`callerId="${OUR_NUMBER}"`);
    // The push WAS started (fire-and-forget), just not awaited.
    expect(pushStarted).toBe(true);
  });
});

describe('founder whisper leg (M1.9b)', () => {
  const founderWhisperQuery =
    '?callerLabel=Tenant%20(Jane%20D.)&conversationId=conv-1&parentCallSid=CAbiz0001&leg=founder';
  const founderGateQuery = '?conversationId=conv-1&parentCallSid=CAbiz0001&leg=founder';

  it('founder whisper announces the caller + press 1 to accept (no press-0 team escape)', async () => {
    const world = createFakeWorld();
    const { app } = founderHarness(world);
    const res = await signedTwilioPost(
      app,
      `/webhooks/twilio/voice/whisper${founderWhisperQuery}`,
      { CallSid: 'CAfounder-leg' },
    );
    expect(res.status).toBe(200);
    const xml = res.text;
    expect(xml).toContain('<Gather');
    expect(xml).toContain('Press 1 to accept');
    expect(xml).not.toContain('reach the team'); // founder IS the team
    expect(xml).not.toContain('+1555'); // never a phone
  });

  it("gate: Digits='1' → <Pause> (bridge proceeds)", async () => {
    const world = createFakeWorld();
    const { app } = founderHarness(world);
    const res = await signedTwilioPost(app, `/webhooks/twilio/voice/whisper-gate${founderGateQuery}`, {
      Digits: '1',
      CallSid: 'CAfounder-leg',
    });
    expect(res.status).toBe(200);
    expect(res.text).toContain('<Pause');
    expect(res.text).not.toContain('<Hangup');
  });

  it("gate: press-0 on the founder leg → <Hangup> (no team escape — falls through to missed)", async () => {
    const world = createFakeWorld();
    const { app } = founderHarness(world);
    const res = await signedTwilioPost(app, `/webhooks/twilio/voice/whisper-gate${founderGateQuery}`, {
      Digits: '0',
      CallSid: 'CAfounder-leg',
    });
    expect(res.status).toBe(200);
    const xml = res.text;
    expect(xml).toContain('<Hangup');
    expect(xml).not.toContain('<Dial');
  });
});

describe('founder call-triage — MISSED → push + auto-text (M1.9b)', () => {
  let world: FakeWorld;

  beforeEach(() => {
    _resetForTests();
    const logger = createLogger({ level: 'info', destination: createLogCapture().stream });
    configureJobsLogger(logger);
    configureScheduler(new InMemorySchedulerAdapter());
    world = createFakeWorld();
    // Wire the auto-text job against the SAME world repos so the webhook's
    // enqueueImmediate runs the job in-process, end-to-end. The send service is
    // a REAL sendMessage wired to the world fakes (opt-out gate exercised).
    registerMissedCallAutoTextJobHandler({
      settingsRepo: world.settingsRepo,
      messagesRepo: world.messagesRepo,
      sendMessageService: createSendMessageService({
        config: makeWebhookHarness({ world }).config,
        logger,
        adapter: world.adapter,
        conversationsRepo: world.conversationsRepo,
        messagesRepo: world.messagesRepo,
        contactsRepo: world.contactsRepo,
        auditRepo: world.auditRepo,
        events: world.events,
      }),
      logger,
    });
    configureOutboundQueue(new InProcessOutboundQueueAdapter({ dispatch: dispatchJob }));
  });

  afterEach(() => {
    _resetForTests();
  });

  /** Run the inbound bridge once so a ringing founder-bridge call exists. */
  async function seedRingingBridge() {
    world.contacts.push({ contactId: 'c-caller', type: 'tenant', phone: CALLER, firstName: 'Jane', lastName: 'Doe' });
    const { app } = founderHarness(world);
    await signedTwilioPost(app, '/webhooks/twilio/voice', bizVoiceParams());
    // Clear the pre-ring push so the missed-call assertions start clean.
    world.pushSends.length = 0;
    return app;
  }

  it('no-answer → missed-call push (with quick-reply actions) + auto-text sent once', async () => {
    const app = await seedRingingBridge();

    await signedTwilioPost(app, '/webhooks/twilio/voice/status', {
      CallSid: 'CAbiz0001',
      DialCallStatus: 'no-answer',
      ApiVersion: '2010-04-01',
    });

    const call = world.messages.find((m) => m.provider_sid === 'CAbiz0001')!;
    expect(call.call_status).toBe('no-answer');
    expect(call.call_outcome).toBe('missed');

    // Missed-call push to the founder, kind missed_call, masked body, actions
    // from the (default) quickReplies, callId for the /quick-reply deep link.
    const missed = world.pushSends.find((p) => p.notification.kind === 'missed_call');
    expect(missed).toBeDefined();
    expect(missed!.userId).toBe(TEST_ADMIN_USER.userId);
    expect(missed!.notification.payload.callId).toBe('CAbiz0001');
    expect(missed!.notification.payload.body).toBe('Missed call — Tenant (Jane D.)');
    const actions = missed!.notification.payload.actions as { action: string; title: string }[];
    expect(actions).toHaveLength(2); // default quickReplies are 2
    expect(actions[0]!.action).toBe('qr-0');
    expect(JSON.stringify(missed!.notification.payload)).not.toContain(CALLER);

    // Zero-tap auto-text fired ONCE into the caller's conversation.
    expect(world.sent).toHaveLength(1);
    expect(world.sent[0]!.to).toBe(CALLER);
    expect(world.sent[0]!.body).toBe(world.settings.missedCallAutoText);
  });

  it('no-answer <Dial action> returns a masked goodbye TwiML — never Twilio\'s generic error', async () => {
    // The <Dial action> URL (= /status) MUST get valid TwiML back, or Twilio
    // plays "an application error has occurred" to the caller on a no-answer
    // (the 2026-06-15 bug — /status used to return an empty 200). We have no
    // voicemail; the caller hears a brief masked goodbye, then hangs up.
    const app = await seedRingingBridge();
    const res = await signedTwilioPost(app, '/webhooks/twilio/voice/status', {
      CallSid: 'CAbiz0001',
      DialCallStatus: 'no-answer',
      ApiVersion: '2010-04-01',
    });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/xml');
    expect(res.text).toContain('<Say');
    expect(res.text).toContain('Sorry we missed your call');
    expect(res.text).toContain('<Hangup');
    expect(res.text).not.toContain(CALLER); // never the caller's number
  });

  it('answered/completed <Dial action> returns clean (empty) TwiML — no goodbye, no error', async () => {
    const app = await seedRingingBridge();
    // ANSWERED is the press-1 gate — accept the bridge first, THEN the Dial
    // summary completes. (A completed-with-duration WITHOUT press-1 is now a
    // MISS — that's the carrier-voicemail fix.)
    await signedTwilioPost(
      app,
      '/webhooks/twilio/voice/whisper-gate?conversationId=x&parentCallSid=CAbiz0001&leg=founder',
      { Digits: '1', CallSid: 'CAfounder-leg' },
    );
    const res = await signedTwilioPost(app, '/webhooks/twilio/voice/status', {
      CallSid: 'CAbiz0001',
      DialCallStatus: 'completed',
      DialCallDuration: '42', // a real bridged call (not a miss)
      ApiVersion: '2010-04-01',
    });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/xml');
    expect(res.text).toContain('<Response'); // valid TwiML envelope
    expect(res.text).not.toContain('<Say'); // the call happened — nothing to say
    expect(res.text).not.toContain('Sorry we missed');
  });

  it('no-press-1 (Dial completed, zero duration) → counted as missed → auto-text', async () => {
    const app = await seedRingingBridge();

    await signedTwilioPost(app, '/webhooks/twilio/voice/status', {
      CallSid: 'CAbiz0001',
      DialCallStatus: 'completed',
      DialCallDuration: '0',
      ApiVersion: '2010-04-01',
    });

    expect(world.pushSends.some((p) => p.notification.kind === 'missed_call')).toBe(true);
    expect(world.sent).toHaveLength(1);
  });

  it('carrier VOICEMAIL answers (completed WITH duration, NO press-1) → MISSED + goodbye (the 2026-06-15 loop bug)', async () => {
    const app = await seedRingingBridge();

    // The founder doesn't pick up → her carrier voicemail answers the leg, the
    // whisper plays into it for ~13s, the gate (no press-1) hangs up. Twilio's
    // <Dial action> reports completed WITH a non-zero duration — which the old
    // duration heuristic misread as "answered" (suppressing the missed handling
    // + the caller goodbye, which left a VoIP caller's leg looping). Press-1 is
    // the answered signal now, so a never-accepted bridge is a MISS.
    const res = await signedTwilioPost(app, '/webhooks/twilio/voice/status', {
      CallSid: 'CAbiz0001',
      DialCallStatus: 'completed',
      DialCallDuration: '13', // voicemail/whisper seconds — NOT a real bridge
      ApiVersion: '2010-04-01',
    });

    const call = world.messages.find((m) => m.provider_sid === 'CAbiz0001')!;
    expect(call.call_outcome).toBe('missed');
    expect(call.answered_at).toBeUndefined();
    expect(call.call_duration).toBeUndefined(); // a miss records no talk time
    expect(world.pushSends.filter((p) => p.notification.kind === 'missed_call')).toHaveLength(1);
    expect(world.sent).toHaveLength(1); // the auto-text fired
    // The caller hears the goodbye (answers + cleanly ends the leg → no loop).
    expect(res.text).toContain('Sorry we missed your call');
    expect(res.text).toContain('<Hangup');
  });

  it('UNKNOWN caller missed → missed PUSH surfaces the caller number (stored label + logs stay masked)', async () => {
    // No contact seeded → unknown caller (so we don't use seedRingingBridge,
    // which seeds Jane). Ring the bridge, clear the pre-ring push, then miss.
    const { app, capture } = founderHarness(world);
    await signedTwilioPost(app, '/webhooks/twilio/voice', bizVoiceParams());
    world.pushSends.length = 0;

    await signedTwilioPost(app, '/webhooks/twilio/voice/status', {
      CallSid: 'CAbiz0001',
      DialCallStatus: 'no-answer',
      ApiVersion: '2010-04-01',
    });

    const missed = world.pushSends.find((p) => p.notification.kind === 'missed_call')!;
    expect(missed).toBeDefined();
    expect(missed.notification.payload.body).toBe('Missed call — (555) 017-7777');
    // Stored call entity stays masked; the number never reaches the logs.
    const call = world.messages.find((m) => m.provider_sid === 'CAbiz0001')!;
    expect(call.call_party_label).toBe('Unknown caller');
    expect(JSON.stringify(capture.lines)).not.toContain(CALLER);
    expect(JSON.stringify(capture.lines)).not.toContain('017-7777');
  });

  it('FIX 1: a child-leg completed with NON-ZERO duration arriving BEFORE the Dial summary does NOT mark answered (real Twilio ordering)', async () => {
    const app = await seedRingingBridge();

    // REAL Twilio ordering for a no-press-1 miss: the founder's whisper leg
    // ANSWERS (the carrier picks up), so the per-<Number statusCallback> CHILD
    // leg fires `completed` with a NON-ZERO CallDuration (the whisper seconds) —
    // and it arrives BEFORE the <Dial action> summary. The buggy handler read
    // that child CallDuration as a bridged-call duration and stamped
    // answered/outcome, suppressing the missed push + auto-text. FIX 1: a child
    // leg (ParentCallSid, NO DialCallStatus) must NOT classify the call.
    await signedTwilioPost(app, '/webhooks/twilio/voice/status', {
      CallSid: 'CAfounder-child-leg',
      ParentCallSid: 'CAbiz0001',
      CallStatus: 'completed',
      CallDuration: '6', // whisper seconds — NOT a connected bridge
      ApiVersion: '2010-04-01',
    });

    // After ONLY the child-leg callback: NOT answered, no duration, no miss
    // side-effects yet (the bridge outcome is undecided until the Dial summary).
    let call = world.messages.find((m) => m.provider_sid === 'CAbiz0001')!;
    expect(call.call_outcome).not.toBe('answered');
    expect(call.answered_at).toBeUndefined();
    expect(call.call_duration).toBeUndefined();
    expect(world.pushSends.some((p) => p.notification.kind === 'missed_call')).toBe(false);
    expect(world.sent).toHaveLength(0);

    // NOW the authoritative <Dial action> summary arrives: completed with ZERO
    // bridged duration → a real MISS. The missed push + auto-text fire exactly
    // once, and the call is NOT recorded as answered.
    await signedTwilioPost(app, '/webhooks/twilio/voice/status', {
      CallSid: 'CAbiz0001',
      DialCallStatus: 'completed',
      DialCallDuration: '0',
      ApiVersion: '2010-04-01',
    });

    call = world.messages.find((m) => m.provider_sid === 'CAbiz0001')!;
    expect(call.call_status).toBe('completed');
    expect(call.call_outcome).toBe('missed');
    expect(call.answered_at).toBeUndefined();
    expect(world.pushSends.filter((p) => p.notification.kind === 'missed_call')).toHaveLength(1);
    expect(world.sent).toHaveLength(1);
    expect(world.sent[0]!.to).toBe(CALLER);
  });

  it('PRESS-1 accept → completed WITH duration → answered, NO auto-text, answered_at set', async () => {
    const app = await seedRingingBridge();

    // The founder ANSWERS and presses 1 — the gate stamps the bridge accepted
    // (answered_at). A child leg may also report (harmless transitional). Then
    // the <Dial action> summary completes with the bridge duration.
    await signedTwilioPost(
      app,
      '/webhooks/twilio/voice/whisper-gate?conversationId=x&parentCallSid=CAbiz0001&leg=founder',
      { Digits: '1', CallSid: 'CAfounder-leg' },
    );
    await signedTwilioPost(app, '/webhooks/twilio/voice/status', {
      CallSid: 'CAfounder-child-leg',
      ParentCallSid: 'CAbiz0001',
      CallStatus: 'completed',
      CallDuration: '4',
      ApiVersion: '2010-04-01',
    });
    await signedTwilioPost(app, '/webhooks/twilio/voice/status', {
      CallSid: 'CAbiz0001',
      DialCallStatus: 'completed',
      DialCallDuration: '42',
      ApiVersion: '2010-04-01',
    });

    const call = world.messages.find((m) => m.provider_sid === 'CAbiz0001')!;
    expect(call.call_status).toBe('completed');
    expect(call.call_outcome).toBe('answered');
    expect(call.call_duration).toBe(42); // the BRIDGE duration, not the leg's
    expect(call.answered_at).toBeDefined(); // stamped by the press-1 gate
    // GUARDRAIL: an answered call never fires the missed push / auto-text.
    expect(world.pushSends.some((p) => p.notification.kind === 'missed_call')).toBe(false);
    expect(world.sent).toHaveLength(0);
  });

  it('ANSWERED (completed with duration) → NO missed push, NO auto-text', async () => {
    const app = await seedRingingBridge();

    // Answered first, then completed with a real duration.
    await signedTwilioPost(app, '/webhooks/twilio/voice/status', {
      CallSid: 'CAbiz0001',
      DialCallStatus: 'answered',
      ApiVersion: '2010-04-01',
    });
    await signedTwilioPost(app, '/webhooks/twilio/voice/status', {
      CallSid: 'CAbiz0001',
      DialCallStatus: 'completed',
      DialCallDuration: '42',
      ApiVersion: '2010-04-01',
    });

    expect(world.pushSends.some((p) => p.notification.kind === 'missed_call')).toBe(false);
    expect(world.sent).toHaveLength(0);
  });

  it('GUARDRAIL: a redelivered missed status callback never double-texts (CallSid idempotent)', async () => {
    const app = await seedRingingBridge();

    const missedStatus = {
      CallSid: 'CAbiz0001',
      DialCallStatus: 'no-answer',
      ApiVersion: '2010-04-01',
    };
    await signedTwilioPost(app, '/webhooks/twilio/voice/status', missedStatus);
    // Redeliver the same terminal callback twice more.
    await signedTwilioPost(app, '/webhooks/twilio/voice/status', missedStatus);
    await signedTwilioPost(app, '/webhooks/twilio/voice/status', missedStatus);

    // Exactly ONE auto-text, ever — the forward-only transition guards the
    // trigger AND the job's CallSid marker guards the send.
    expect(world.sent).toHaveLength(1);
  });

  it('auto-text DISABLED in settings → missed push still sent, but NO text', async () => {
    const app = await seedRingingBridge();
    world.settings.missedCallAutoTextEnabled = false;

    await signedTwilioPost(app, '/webhooks/twilio/voice/status', {
      CallSid: 'CAbiz0001',
      DialCallStatus: 'busy',
      ApiVersion: '2010-04-01',
    });

    expect(world.pushSends.some((p) => p.notification.kind === 'missed_call')).toBe(true);
    expect(world.sent).toHaveLength(0); // toggle off → no auto-text
  });

  it('caller opted out → auto-text refused (SendRefusedError) → skipped, not retried', async () => {
    const app = await seedRingingBridge();
    // Flip the caller's conversation to opted-out (the send wrapper refuses).
    const conv = [...world.conversations.values()].find((c) => c.participant_phone === CALLER)!;
    conv.sms_opt_out = true;

    await signedTwilioPost(app, '/webhooks/twilio/voice/status', {
      CallSid: 'CAbiz0001',
      DialCallStatus: 'no-answer',
      ApiVersion: '2010-04-01',
    });

    // Push still went (the founder should know); the auto-text was refused.
    expect(world.pushSends.some((p) => p.notification.kind === 'missed_call')).toBe(true);
    expect(world.sent).toHaveLength(0);
  });
});
