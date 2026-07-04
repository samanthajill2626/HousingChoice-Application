// Voice Phase 1 (backend) golden suite — the OUTBOUND masked-calling direction
// (spec §5-§9). Driven through the REAL app (buildApp) + the world fakes:
//   - originate happy path (rings NAVIGATOR cell, from BUSINESS, persists an
//     outbound call entry) + the two 409 guards (no verified cell; voice_opt_out)
//     that place NO call;
//   - the outbound-bridge whisper → (press-1) <Dial> the target with
//     callerId=business + record-from-answer-dual, target ONLY inside <Number>;
//   - inbound dials the HOLDER's verified cell (no env-var fallback) + text-us fallback w/o holder;
//   - self cell verify-start/confirm (success/expired/mismatch/too-many);
//   - inbound-line assign single-holder + 409 on unverified;
//   - the voice_opt_out route;
//   - PII: no raw phone in any stored call label, TwiML URL, or log line.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import {
  InMemorySchedulerAdapter,
  type OutboundQueueAdapter,
  type EnqueueQueueOptions,
} from '../src/adapters/scheduler.js';
import {
  _resetForTests,
  configureOutboundQueue,
  configureScheduler,
} from '../src/jobs/jobs.js';
import type { JobEnvelope } from '../src/jobs/types.js';
import {
  createFakeWorld,
  makeWebhookHarness,
  signedTwilioPost,
  ORIGIN_SECRET,
  OUR_NUMBER,
  type FakeWorld,
} from './helpers/twilioWebhookHarness.js';
import {
  TEST_ADMIN_COOKIE,
  TEST_ADMIN_USER,
  TEST_SESSION_COOKIE,
  TEST_SESSION_USER,
} from './helpers/authSession.js';
import { hashCellVerifyCode } from '../src/lib/cellVerification.js';
import { resolveMessage } from '../src/messages/index.js';

/** A recording outbound-queue adapter that captures enqueued jobs without dispatching them. */
class RecordingOutboundQueue implements OutboundQueueAdapter {
  readonly enqueued: { envelope: JobEnvelope; opts?: EnqueueQueueOptions }[] = [];
  async enqueue(envelope: JobEnvelope, opts?: EnqueueQueueOptions): Promise<void> {
    this.enqueued.push({ envelope, opts });
  }
}

const SECRET = ORIGIN_SECRET;
const NAV_CELL = '+15550140000'; // the calling navigator's verified cell
const TARGET = '+15550188888'; // the contact's phone (never exposed to logs/URLs)

/** Give the seeded VA (TEST_SESSION_USER) a verified cell so they can place calls. */
function seedNavigatorCell(harness: ReturnType<typeof makeWebhookHarness>, cell = NAV_CELL): void {
  const nav = harness.fakeUsers.users.get(TEST_SESSION_USER.userId)!;
  nav.cell = cell;
  nav.cell_verified_at = '2026-07-01T00:00:00.000Z';
}

function seedContact(world: FakeWorld, over: Record<string, unknown> = {}): string {
  const contactId = 'c-target';
  world.contacts.push({
    contactId,
    type: 'tenant',
    phone: TARGET,
    firstName: 'Jane',
    lastName: 'Doe',
    ...over,
  } as never);
  return contactId;
}

// ---------------------------------------------------------------------------
// A. Originate — POST /api/contacts/:contactId/call
// ---------------------------------------------------------------------------
describe('POST /api/contacts/:contactId/call — originate (spec §5)', () => {
  it('happy path: rings the NAVIGATOR cell FROM the business number, persists an outbound call entry', async () => {
    const world = createFakeWorld();
    const contactId = seedContact(world);
    const harness = makeWebhookHarness({ world });
    seedNavigatorCell(harness);

    const res = await request(harness.app)
      .post(`/api/contacts/${contactId}/call`)
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({});
    expect(res.status).toBe(200);
    expect(typeof res.body.callSid).toBe('string');

    // initiateCall was called with to=navigator cell, from=business number.
    expect(world.initiatedCalls).toHaveLength(1);
    const call = world.initiatedCalls[0]!;
    expect(call.to).toBe(NAV_CELL);
    expect(call.from).toBe(OUR_NUMBER);
    // The TwiML URL carries ONLY the opaque conversationId — NEVER the target phone.
    expect(call.twimlUrl).toContain('/webhooks/twilio/voice/outbound-bridge');
    expect(call.twimlUrl).toContain('conversationId=');
    expect(call.twimlUrl).not.toContain(TARGET);
    expect(call.twimlUrl).not.toContain(NAV_CELL);

    // A masked outbound call entry is persisted.
    const entries = world.messages.filter((m) => m.type === 'call');
    expect(entries).toHaveLength(1);
    const entry = entries[0]!;
    expect(entry.direction).toBe('outbound');
    expect(entry.author).toBe('teammate');
    expect(entry.call_status).toBe('ringing');
    expect(entry.masked).toBe(false);
    expect(entry.provider_sid).toBe(res.body.callSid);
    // The stored label is the MASKED contact (role/name) — NEVER a raw phone.
    expect(entry.call_party_label).toBe('Tenant (Jane D.)');
    expect(entry.call_party_label).not.toContain('+');
    expect(entry.call_party_label).not.toContain(TARGET);

    // message.persisted emitted once for the new entry.
    expect(world.emitted.filter((e) => e.event === 'message.persisted')).toHaveLength(1);

    // PII: neither the navigator cell nor the target appears in any log line.
    expect(JSON.stringify(harness.capture.lines)).not.toContain(NAV_CELL);
    expect(JSON.stringify(harness.capture.lines)).not.toContain(TARGET);
  });

  it('409 cell_not_verified when the navigator has no verified cell — NO call placed', async () => {
    const world = createFakeWorld();
    const contactId = seedContact(world);
    const harness = makeWebhookHarness({ world });
    // Navigator has a cell but it is NOT verified.
    const nav = harness.fakeUsers.users.get(TEST_SESSION_USER.userId)!;
    nav.cell = NAV_CELL; // no cell_verified_at

    const res = await request(harness.app)
      .post(`/api/contacts/${contactId}/call`)
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('cell_not_verified');
    expect(world.initiatedCalls).toHaveLength(0);
    expect(world.messages.filter((m) => m.type === 'call')).toHaveLength(0);
  });

  it('409 contact_voice_opted_out when the contact is do-not-call — NO call placed', async () => {
    const world = createFakeWorld();
    const contactId = seedContact(world, { voice_opt_out: true });
    const harness = makeWebhookHarness({ world });
    seedNavigatorCell(harness);

    const res = await request(harness.app)
      .post(`/api/contacts/${contactId}/call`)
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('contact_voice_opted_out');
    expect(world.initiatedCalls).toHaveLength(0);
    expect(world.messages.filter((m) => m.type === 'call')).toHaveLength(0);
  });

  it('404 contact_not_found for an unknown contact', async () => {
    const world = createFakeWorld();
    const harness = makeWebhookHarness({ world });
    seedNavigatorCell(harness);
    const res = await request(harness.app)
      .post('/api/contacts/nope/call')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({});
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('contact_not_found');
    expect(world.initiatedCalls).toHaveLength(0);
  });

  it('400 invalid_phone when an explicit phone is not one of the contact\'s numbers', async () => {
    const world = createFakeWorld();
    const contactId = seedContact(world);
    const harness = makeWebhookHarness({ world });
    seedNavigatorCell(harness);
    const res = await request(harness.app)
      .post(`/api/contacts/${contactId}/call`)
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ phone: '+15559990000' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_phone');
    expect(world.initiatedCalls).toHaveLength(0);
  });

  it('401 unauthenticated', async () => {
    const world = createFakeWorld();
    const contactId = seedContact(world);
    const { app } = makeWebhookHarness({ world });
    const res = await request(app)
      .post(`/api/contacts/${contactId}/call`)
      .set('x-origin-verify', SECRET)
      .send({});
    expect(res.status).toBe(401);
  });

  it('409 contact_voice_opted_out when voice_opt_out contact has NO phone — DNC wins over invalid_phone (spec §5 step ordering)', async () => {
    // A contact that is do-not-call AND has no phone must get 409 contact_voice_opted_out,
    // not 400 invalid_phone. The voice_opt_out guard must run BEFORE phone resolution.
    const world = createFakeWorld();
    // Seed a voice_opt_out contact without any phone number.
    const contactId = 'c-no-phone-dnc';
    world.contacts.push({
      contactId,
      type: 'tenant',
      // deliberately no `phone` field
      firstName: 'No',
      lastName: 'Phone',
      voice_opt_out: true,
    } as never);
    const harness = makeWebhookHarness({ world });
    seedNavigatorCell(harness);

    const res = await request(harness.app)
      .post(`/api/contacts/${contactId}/call`)
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('contact_voice_opted_out');
    expect(world.initiatedCalls).toHaveLength(0);
  });

  it('503 voice_not_configured when business caller ID is undefined — initiateCall NOT called', async () => {
    const world = createFakeWorld();
    const contactId = seedContact(world);
    // Build a harness without any OUR_PHONE_NUMBERS so config.ourPhoneNumbers[0] is undefined.
    const harness = makeWebhookHarness({ world, env: { OUR_PHONE_NUMBERS: '' } });
    seedNavigatorCell(harness);

    const res = await request(harness.app)
      .post(`/api/contacts/${contactId}/call`)
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({});
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('voice_not_configured');
    expect(world.initiatedCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// B. Outbound-bridge webhook + whisper-gate outbound branch
// ---------------------------------------------------------------------------
describe('POST /webhooks/twilio/voice/outbound-bridge (spec §5)', () => {
  /** Originate a call so a ringing outbound entry + its conversation exist. */
  async function originate(): Promise<{ world: FakeWorld; harness: ReturnType<typeof makeWebhookHarness>; conversationId: string; callSid: string }> {
    const world = createFakeWorld();
    const contactId = seedContact(world);
    const harness = makeWebhookHarness({ world });
    seedNavigatorCell(harness);
    const res = await request(harness.app)
      .post(`/api/contacts/${contactId}/call`)
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({});
    const twimlUrl = world.initiatedCalls[0]!.twimlUrl;
    const conversationId = new URL(twimlUrl).searchParams.get('conversationId')!;
    return { world, harness, conversationId, callSid: res.body.callSid };
  }

  it('whisper on the navigator leg: announces the masked contact + press-1, target NOT in the TwiML', async () => {
    const { harness, conversationId } = await originate();
    const res = await signedTwilioPost(
      harness.app,
      `/webhooks/twilio/voice/outbound-bridge?conversationId=${encodeURIComponent(conversationId)}`,
      { CallSid: 'CAnav-leg' },
    );
    expect(res.status).toBe(200);
    const xml = res.text;
    expect(xml).toContain('<Gather');
    // The whisper copy comes from the catalog (single source of truth), with the
    // masked target label interpolated (never a phone).
    expect(xml).toContain(resolveMessage('voice.whisper_outbound', { targetLabel: 'Tenant (Jane D.)' }));
    // The whisper-gate action carries ONLY the opaque conversationId + outbound=1.
    expect(xml).toContain('/webhooks/twilio/voice/whisper-gate');
    expect(xml).toContain('outbound=1');
    // GUARDRAIL: the raw target phone is NEVER in the whisper TwiML.
    expect(xml).not.toContain(TARGET);
    expect(xml).toContain('<Hangup'); // no-input fallthrough
  });

  it('press-1 on the outbound gate → <Dial> the target from the BUSINESS number, record-from-answer-dual, target ONLY inside <Number>', async () => {
    const { harness, conversationId, callSid } = await originate();
    const res = await signedTwilioPost(
      harness.app,
      `/webhooks/twilio/voice/whisper-gate?conversationId=${encodeURIComponent(conversationId)}&parentCallSid=${encodeURIComponent(callSid)}&outbound=1`,
      { Digits: '1', CallSid: 'CAnav-leg' },
    );
    expect(res.status).toBe(200);
    const xml = res.text;
    // callerId is ALWAYS the business number, NEVER the navigator cell.
    expect(xml).toContain(`callerId="${OUR_NUMBER}"`);
    expect(xml).not.toContain(NAV_CELL);
    // The outbound call RECORDS like the founder bridge.
    expect(xml).toContain('record="record-from-answer-dual"');
    expect(xml).toContain('/webhooks/twilio/voice/recording');
    expect(xml).toContain('/webhooks/twilio/voice/status');
    // The target appears ONLY inside <Number>…</Number> — never in any URL attr.
    expect(xml).toContain(`<Number>${TARGET}</Number>`);
    const numberIdx = xml.indexOf(`<Number>${TARGET}</Number>`);
    const beforeNumber = xml.slice(0, numberIdx);
    expect(beforeNumber).not.toContain(TARGET); // not in the URLs above the <Number>
  });

  it('press-1 stamps the outbound call answered (answered_at) via the gate', async () => {
    const { world, harness, conversationId, callSid } = await originate();
    await signedTwilioPost(
      harness.app,
      `/webhooks/twilio/voice/whisper-gate?conversationId=${encodeURIComponent(conversationId)}&parentCallSid=${encodeURIComponent(callSid)}&outbound=1`,
      { Digits: '1', CallSid: 'CAnav-leg' },
    );
    const entry = world.messages.find((m) => m.provider_sid === callSid)!;
    expect(entry.call_status).toBe('in-progress');
    expect(entry.answered_at).toBeDefined();
  });

  it('timeout (no press-1) on the outbound gate → <Hangup>, never a <Dial>', async () => {
    const { harness, conversationId, callSid } = await originate();
    const res = await signedTwilioPost(
      harness.app,
      `/webhooks/twilio/voice/whisper-gate?conversationId=${encodeURIComponent(conversationId)}&parentCallSid=${encodeURIComponent(callSid)}&outbound=1`,
      { CallSid: 'CAnav-leg' }, // no Digits
    );
    expect(res.status).toBe(200);
    expect(res.text).toContain('<Hangup');
    expect(res.text).not.toContain('<Dial');
  });

  // DNC re-check at press-1 (docs/issues/voice-bridge-dnc-recheck.md): the
  // originate service refuses voice_opt_out PRE-dial, but staff can set the
  // flag in the seconds between originate and the navigator's press-1 — the
  // gate must re-check the freshly-loaded contact and hang up INSTEAD of
  // dialing.
  it('press-1 after the contact was marked voice_opt_out mid-ring → <Hangup>, NO <Dial>, IDs-only log', async () => {
    const { world, harness, conversationId, callSid } = await originate();
    // Staff mark the contact company do-not-call AFTER originate succeeded.
    const contact = world.contacts.find((c) => c.contactId === 'c-target')!;
    contact.voice_opt_out = true;

    const res = await signedTwilioPost(
      harness.app,
      `/webhooks/twilio/voice/whisper-gate?conversationId=${encodeURIComponent(conversationId)}&parentCallSid=${encodeURIComponent(callSid)}&outbound=1`,
      { Digits: '1', CallSid: 'CAnav-leg' },
    );
    expect(res.status).toBe(200);
    expect(res.text).toContain('<Hangup');
    expect(res.text).not.toContain('<Dial');
    expect(res.text).not.toContain(TARGET);

    // The call was never stamped accepted — the leg just ends (the status
    // callback stamps the terminal outcome as usual).
    const entry = world.messages.find((m) => m.provider_sid === callSid)!;
    expect(entry.call_status).toBe('ringing');
    expect(entry.answered_at).toBeUndefined();

    // The refusal is logged at IDs-only — and no raw phone anywhere in logs.
    const lines = JSON.stringify(harness.capture.lines);
    expect(lines).toContain('target opted out mid-ring');
    expect(lines).not.toContain(TARGET);
    expect(lines).not.toContain(NAV_CELL);
  });

  it('status callback on the originated CallSid stamps the outbound entry (answered)', async () => {
    const { world, harness, conversationId, callSid } = await originate();
    // press-1 accept, then the <Dial action> summary completes with a duration.
    await signedTwilioPost(
      harness.app,
      `/webhooks/twilio/voice/whisper-gate?conversationId=${encodeURIComponent(conversationId)}&parentCallSid=${encodeURIComponent(callSid)}&outbound=1`,
      { Digits: '1', CallSid: 'CAnav-leg' },
    );
    await signedTwilioPost(harness.app, '/webhooks/twilio/voice/status', {
      CallSid: callSid,
      DialCallStatus: 'completed',
      DialCallDuration: '30',
      ApiVersion: '2010-04-01',
    });
    const entry = world.messages.find((m) => m.provider_sid === callSid)!;
    expect(entry.call_status).toBe('completed');
    expect(entry.call_outcome).toBe('answered');
    expect(entry.call_duration).toBe(30);
  });

  // B-missed: outbound call that the target never answers must NOT fire
  // onFounderBridgeMissed — no missed-call push, no MISSED_CALL_AUTOTEXT_JOB.
  // (Regression test for review finding I-1 / I-2.)
  describe('outbound missed-call — no false "we missed your call" auto-text or push', () => {
    let recordingQueue: RecordingOutboundQueue;

    beforeEach(() => {
      configureScheduler(new InMemorySchedulerAdapter());
      recordingQueue = new RecordingOutboundQueue();
      configureOutboundQueue(recordingQueue);
    });

    afterEach(() => {
      _resetForTests();
    });

    it('navigator no-answer (target never picks up) → call stamped missed, NO push, NO auto-text job', async () => {
      const world = createFakeWorld();
      const contactId = seedContact(world);
      const harness = makeWebhookHarness({ world });
      seedNavigatorCell(harness);

      // Originate the call.
      const res = await request(harness.app)
        .post(`/api/contacts/${contactId}/call`)
        .set('x-origin-verify', SECRET)
        .set('cookie', TEST_SESSION_COOKIE)
        .send({});
      expect(res.status).toBe(200);
      const { callSid } = res.body as { callSid: string };

      // The navigator does NOT press 1 (or target doesn't answer).
      // The <Dial action> summary fires with a terminal no-answer status.
      await signedTwilioPost(harness.app, '/webhooks/twilio/voice/status', {
        CallSid: callSid,
        DialCallStatus: 'no-answer',
        ApiVersion: '2010-04-01',
      });

      const entry = world.messages.find((m) => m.provider_sid === callSid)!;
      expect(entry.call_status).toBe('no-answer');
      expect(entry.call_outcome).toBe('missed');

      // NO missed-call push (founders should NOT see a phantom "missed call").
      const missedPush = world.pushSends.find((p) => p.notification.kind === 'missed_call');
      expect(missedPush).toBeUndefined();

      // NO MISSED_CALL_AUTOTEXT_JOB enqueued (contact should NOT get a false
      // "sorry we missed your call, text us" SMS).
      expect(recordingQueue.enqueued).toHaveLength(0);

      // Also: no SMS was sent (world.sent stays empty).
      expect(world.sent).toHaveLength(0);
    });
  });
});

// ---------------------------------------------------------------------------
// C. Inbound change — ring the holder's verified cell (no env-var fallback) (spec §6)
// ---------------------------------------------------------------------------
describe('inbound founder-triage rings the inbound-voice-line holder (spec §6)', () => {
  const CALLER = '+15550177777';
  const HOLDER_CELL = '+15550163333';

  function bizVoiceParams(over: Record<string, string> = {}): Record<string, string> {
    return {
      CallSid: 'CAin0001',
      AccountSid: 'ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
      From: CALLER,
      To: OUR_NUMBER,
      CallStatus: 'ringing',
      Direction: 'inbound',
      ApiVersion: '2010-04-01',
      ...over,
    };
  }

  it('dials the HOLDER\'s verified cell and pushes the holder', async () => {
    const world = createFakeWorld();
    const harness = makeWebhookHarness({ world });
    const holder = harness.fakeUsers.users.get(TEST_ADMIN_USER.userId)!;
    holder.cell = HOLDER_CELL;
    holder.cell_verified_at = '2026-07-01T00:00:00.000Z';
    await harness.fakeUsers.repo.assignInboundVoiceLine(holder.userId); // via the pointer

    const res = await signedTwilioPost(harness.app, '/webhooks/twilio/voice', bizVoiceParams());
    expect(res.status).toBe(200);
    const xml = res.text;
    expect(xml).toContain(HOLDER_CELL); // the holder's cell is dialed
    expect(xml).toContain(`callerId="${OUR_NUMBER}"`);
    // Pre-ring push targets the holder.
    expect(world.pushSends).toHaveLength(1);
    expect(world.pushSends[0]!.userId).toBe(TEST_ADMIN_USER.userId);
    expect(world.pushSends[0]!.notification.kind).toBe('pre_ring');
  });

  it('no holder (no env-var fallback) → ERROR log + text-us fallback, NO bridge, NO push, NO leak', async () => {
    const world = createFakeWorld();
    const harness = makeWebhookHarness({ world }); // no holder assigned
    const res = await signedTwilioPost(harness.app, '/webhooks/twilio/voice', bizVoiceParams());
    expect(res.status).toBe(200);
    const xml = res.text;
    expect(xml).not.toContain('<Dial');
    expect(xml).toContain('<Hangup');
    expect(xml).toContain('text message');
    expect(xml).not.toContain(CALLER);
    expect(world.pushSends).toHaveLength(0);
    // The misconfig is observable: an ERROR-level (50) log, PII-free.
    const noHolder = harness.capture.atLevel(50).find((l) =>
      String(l['msg']).includes('NO inbound-voice-line holder with a verified cell'),
    );
    expect(noHolder, 'expected an ERROR log for the no-holder misconfig').toBeDefined();
    expect(noHolder!['hasVerifiedHolder']).toBe(false);
    expect(JSON.stringify(noHolder)).not.toContain(CALLER);
  });

  it('holder cell is UNVERIFIED → text-us fallback (never dialed), NO bridge, NO push', async () => {
    const world = createFakeWorld();
    const harness = makeWebhookHarness({ world });
    const holder = harness.fakeUsers.users.get(TEST_ADMIN_USER.userId)!;
    holder.cell = HOLDER_CELL; // present but NOT verified
    await harness.fakeUsers.repo.assignInboundVoiceLine(holder.userId); // via the pointer

    const res = await signedTwilioPost(harness.app, '/webhooks/twilio/voice', bizVoiceParams());
    expect(res.status).toBe(200);
    const xml = res.text;
    // No env-var fallback: an unverified holder cell means NO bridge at all.
    expect(xml).not.toContain('<Dial');
    expect(xml).not.toContain(HOLDER_CELL); // an unverified cell is never dialed
    expect(xml).toContain('text message');
    expect(world.pushSends).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// D. Cell verification — self routes (spec §7)
// ---------------------------------------------------------------------------
describe('self cell verification (spec §7)', () => {
  // D-flex: verify-start accepts human-format — normalizes and stores/sends E.164
  describe('flexible phone entry (task 2)', () => {
    it('verify-start: human-format "(404) 982-4978" → 200; stores +14049824978; SMS goes to +14049824978', async () => {
      const world = createFakeWorld();
      const harness = makeWebhookHarness({ world });

      const start = await request(harness.app)
        .post('/api/users/me/cell/verify-start')
        .set('x-origin-verify', SECRET)
        .set('cookie', TEST_SESSION_COOKIE)
        .send({ cell: '(404) 982-4978' });
      expect(start.status).toBe(200);
      expect(start.body.ok).toBe(true);

      // SMS went to the NORMALIZED E.164 — not the raw string.
      expect(world.sent).toHaveLength(1);
      expect(world.sent[0]!.to).toBe('+14049824978');

      // The pending cell stored on the user is also the NORMALIZED E.164.
      const user = harness.fakeUsers.users.get(TEST_SESSION_USER.userId)!;
      expect(user.cell_pending).toBe('+14049824978');
    });

    it('verify-start: "404" (too short) → 400 invalid_cell; nothing stored/sent', async () => {
      const world = createFakeWorld();
      const harness = makeWebhookHarness({ world });
      const res = await request(harness.app)
        .post('/api/users/me/cell/verify-start')
        .set('x-origin-verify', SECRET)
        .set('cookie', TEST_SESSION_COOKIE)
        .send({ cell: '404' });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid_cell');
      expect(world.sent).toHaveLength(0);
      const user = harness.fakeUsers.users.get(TEST_SESSION_USER.userId)!;
      expect(user.cell_pending).toBeUndefined();
    });

    it('verify-start: "not a phone" → 400 invalid_cell; nothing stored/sent', async () => {
      const world = createFakeWorld();
      const harness = makeWebhookHarness({ world });
      const res = await request(harness.app)
        .post('/api/users/me/cell/verify-start')
        .set('x-origin-verify', SECRET)
        .set('cookie', TEST_SESSION_COOKIE)
        .send({ cell: 'not a phone' });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid_cell');
      expect(world.sent).toHaveLength(0);
    });

    it('verify-start: "+0123" (bad shape) → 400 invalid_cell; nothing stored/sent', async () => {
      const world = createFakeWorld();
      const harness = makeWebhookHarness({ world });
      const res = await request(harness.app)
        .post('/api/users/me/cell/verify-start')
        .set('x-origin-verify', SECRET)
        .set('cookie', TEST_SESSION_COOKIE)
        .send({ cell: '+0123' });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid_cell');
      expect(world.sent).toHaveLength(0);
    });

    it('originate: human-format number the contact OWNS → call placed to the E.164', async () => {
      // Contact owns +14705550132; request sends "(470) 555-0132".
      const world = createFakeWorld();
      const contactId = 'c-flex-owned';
      const ownedE164 = '+14705550132';
      world.contacts.push({
        contactId,
        type: 'tenant',
        phone: ownedE164,
        firstName: 'Flex',
        lastName: 'Test',
      } as never);
      const harness = makeWebhookHarness({ world });
      seedNavigatorCell(harness);

      const res = await request(harness.app)
        .post(`/api/contacts/${contactId}/call`)
        .set('x-origin-verify', SECRET)
        .set('cookie', TEST_SESSION_COOKIE)
        .send({ phone: '(470) 555-0132' });
      expect(res.status).toBe(200);
      expect(typeof res.body.callSid).toBe('string');
      // A call was placed.
      expect(world.initiatedCalls).toHaveLength(1);
    });

    it('originate: human-format number the contact does NOT own → same refusal as before (invalid_phone / 400), no call', async () => {
      // Contact owns +14705550132; request sends a different number in human format.
      const world = createFakeWorld();
      const contactId = 'c-flex-notowned';
      world.contacts.push({
        contactId,
        type: 'tenant',
        phone: '+14705550132',
        firstName: 'Flex',
        lastName: 'NotOwned',
      } as never);
      const harness = makeWebhookHarness({ world });
      seedNavigatorCell(harness);

      const res = await request(harness.app)
        .post(`/api/contacts/${contactId}/call`)
        .set('x-origin-verify', SECRET)
        .set('cookie', TEST_SESSION_COOKIE)
        .send({ phone: '(404) 111-2222' });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid_phone');
      expect(world.initiatedCalls).toHaveLength(0);
    });

    it('originate: garbage phone → 400 invalid_phone, no call', async () => {
      const world = createFakeWorld();
      const contactId = seedContact(world);
      const harness = makeWebhookHarness({ world });
      seedNavigatorCell(harness);

      const res = await request(harness.app)
        .post(`/api/contacts/${contactId}/call`)
        .set('x-origin-verify', SECRET)
        .set('cookie', TEST_SESSION_COOKIE)
        .send({ phone: 'not-a-phone' });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid_phone');
      expect(world.initiatedCalls).toHaveLength(0);
    });
  });

  it('verify-start sends the code via the adapter + verify-confirm succeeds', async () => {
    const world = createFakeWorld();
    const harness = makeWebhookHarness({ world });

    const start = await request(harness.app)
      .post('/api/users/me/cell/verify-start')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ cell: NAV_CELL });
    expect(start.status).toBe(200);
    expect(start.body.ok).toBe(true);
    // A code SMS went out via the adapter (world.sent), to the cell.
    expect(world.sent).toHaveLength(1);
    expect(world.sent[0]!.to).toBe(NAV_CELL);
    const bodyText = world.sent[0]!.body!;
    const code = /(\d{6})/.exec(bodyText)![1]!;
    // PII/secret: the code is never logged.
    expect(JSON.stringify(harness.capture.lines)).not.toContain(code);

    const confirm = await request(harness.app)
      .post('/api/users/me/cell/verify-confirm')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ code });
    expect(confirm.status).toBe(200);
    expect(confirm.body.ok).toBe(true);
    expect(typeof confirm.body.cell_verified_at).toBe('string');
    // The cell is now on the user (verified).
    const user = harness.fakeUsers.users.get(TEST_SESSION_USER.userId)!;
    expect(user.cell).toBe(NAV_CELL);
    expect(user.cell_verified_at).toBeDefined();
  });

  it('verify-start rejects a non-E.164 cell (400 invalid_cell), sends nothing', async () => {
    const world = createFakeWorld();
    const harness = makeWebhookHarness({ world });
    const res = await request(harness.app)
      .post('/api/users/me/cell/verify-start')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ cell: '555-1234' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_cell');
    expect(world.sent).toHaveLength(0);
  });

  it('verify-confirm mismatch → 400 invalid_code', async () => {
    const world = createFakeWorld();
    const harness = makeWebhookHarness({ world });
    const user = harness.fakeUsers.users.get(TEST_SESSION_USER.userId)!;
    user.cell_pending = NAV_CELL;
    user.cell_verify_code_hash = hashCellVerifyCode('123456');
    user.cell_verify_expires_at = '2999-01-01T00:00:00.000Z';
    user.cell_verify_attempts = 0;

    const res = await request(harness.app)
      .post('/api/users/me/cell/verify-confirm')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ code: '000000' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_code');
  });

  it('verify-confirm expired → 410 code_expired', async () => {
    const world = createFakeWorld();
    const harness = makeWebhookHarness({ world });
    const user = harness.fakeUsers.users.get(TEST_SESSION_USER.userId)!;
    user.cell_pending = NAV_CELL;
    user.cell_verify_code_hash = hashCellVerifyCode('123456');
    user.cell_verify_expires_at = '2000-01-01T00:00:00.000Z'; // past
    user.cell_verify_attempts = 0;

    const res = await request(harness.app)
      .post('/api/users/me/cell/verify-confirm')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ code: '123456' });
    expect(res.status).toBe(410);
    expect(res.body.error).toBe('code_expired');
  });

  it('verify-confirm too-many-attempts → 429', async () => {
    const world = createFakeWorld();
    const harness = makeWebhookHarness({ world });
    const user = harness.fakeUsers.users.get(TEST_SESSION_USER.userId)!;
    user.cell_pending = NAV_CELL;
    user.cell_verify_code_hash = hashCellVerifyCode('123456');
    user.cell_verify_expires_at = '2999-01-01T00:00:00.000Z';
    user.cell_verify_attempts = 5; // at the cap

    const res = await request(harness.app)
      .post('/api/users/me/cell/verify-confirm')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ code: '123456' });
    expect(res.status).toBe(429);
    expect(res.body.error).toBe('too_many_attempts');
  });

  it('GET /api/users/me returns the self view with cell fields', async () => {
    const world = createFakeWorld();
    const harness = makeWebhookHarness({ world });
    const user = harness.fakeUsers.users.get(TEST_SESSION_USER.userId)!;
    user.cell = NAV_CELL;
    user.cell_verified_at = '2026-07-01T00:00:00.000Z';
    const res = await request(harness.app)
      .get('/api/users/me')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE);
    expect(res.status).toBe(200);
    expect(res.body.user.userId).toBe(TEST_SESSION_USER.userId);
    expect(res.body.user.cell).toBe(NAV_CELL);
    expect(res.body.user.cell_verified_at).toBe('2026-07-01T00:00:00.000Z');
  });
});

// ---------------------------------------------------------------------------
// E. Inbound-voice-line admin routes + voice_opt_out (spec §6/§8)
// ---------------------------------------------------------------------------
describe('inbound-voice-line assignment (admin, spec §6)', () => {
  it('assign requires a verified cell (409 cell_not_verified) then succeeds + is single-holder', async () => {
    const world = createFakeWorld();
    const harness = makeWebhookHarness({ world });
    // A second admin user to prove single-holder reassignment.
    harness.fakeUsers.users.set('usr_other', {
      userId: 'usr_other',
      email: 'other@housingchoice.org',
      role: 'admin',
      status: 'active',
      session_epoch: 1,
      created_at: '2026-06-01T00:00:00.000Z',
      cell: '+15550166666',
      cell_verified_at: '2026-07-01T00:00:00.000Z',
    });
    // usr_other currently holds it — establish via the authoritative pointer.
    await harness.fakeUsers.repo.assignInboundVoiceLine('usr_other');
    const target = harness.fakeUsers.users.get(TEST_ADMIN_USER.userId)!;

    // Target has NO verified cell → 409.
    const denied = await request(harness.app)
      .post(`/api/users/${TEST_ADMIN_USER.userId}/inbound-voice-line`)
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_ADMIN_COOKIE)
      .send({});
    expect(denied.status).toBe(409);
    expect(denied.body.error).toBe('cell_not_verified');
    // The target did NOT become the holder (usr_other still holds it).
    expect((await harness.fakeUsers.repo.getInboundVoiceLineHolder())!.userId).toBe('usr_other');

    // Verify the target's cell, then assign → 200, and the prior holder is cleared.
    target.cell = '+15550167777';
    target.cell_verified_at = '2026-07-01T00:00:00.000Z';
    const ok = await request(harness.app)
      .post(`/api/users/${TEST_ADMIN_USER.userId}/inbound-voice-line`)
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_ADMIN_COOKIE)
      .send({});
    expect(ok.status).toBe(200);
    expect(ok.body.user.inbound_voice_line).toBe(true); // the view still derives the badge
    // Single-holder: the pointer now designates the target, not usr_other.
    expect((await harness.fakeUsers.repo.getInboundVoiceLineHolder())!.userId).toBe(
      TEST_ADMIN_USER.userId,
    );
  });

  it('DELETE unassigns the holder (200)', async () => {
    const world = createFakeWorld();
    const harness = makeWebhookHarness({ world });
    const target = harness.fakeUsers.users.get(TEST_ADMIN_USER.userId)!;
    target.cell = '+15550167777';
    target.cell_verified_at = '2026-07-01T00:00:00.000Z';
    await harness.fakeUsers.repo.assignInboundVoiceLine(target.userId); // holder via pointer

    const res = await request(harness.app)
      .delete(`/api/users/${TEST_ADMIN_USER.userId}/inbound-voice-line`)
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_ADMIN_COOKIE);
    expect(res.status).toBe(200);
    // No holder remains after the clear.
    expect(await harness.fakeUsers.repo.getInboundVoiceLineHolder()).toBeUndefined();
  });

  it('a VA cannot assign the inbound-voice-line (403)', async () => {
    const world = createFakeWorld();
    const harness = makeWebhookHarness({ world });
    const res = await request(harness.app)
      .post(`/api/users/${TEST_ADMIN_USER.userId}/inbound-voice-line`)
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE) // VA
      .send({});
    expect(res.status).toBe(403);
  });

  it('GET /api/users projects cell / cell_verified_at / inbound_voice_line', async () => {
    const world = createFakeWorld();
    const harness = makeWebhookHarness({ world });
    const admin = harness.fakeUsers.users.get(TEST_ADMIN_USER.userId)!;
    admin.cell = '+15550168888';
    admin.cell_verified_at = '2026-07-01T00:00:00.000Z';
    await harness.fakeUsers.repo.assignInboundVoiceLine(admin.userId); // holder via pointer
    const res = await request(harness.app)
      .get('/api/users')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_ADMIN_COOKIE);
    expect(res.status).toBe(200);
    const view = res.body.users.find((u: { userId: string }) => u.userId === TEST_ADMIN_USER.userId);
    expect(view.cell).toBe('+15550168888');
    expect(view.cell_verified_at).toBe('2026-07-01T00:00:00.000Z');
    expect(view.inbound_voice_line).toBe(true);
  });
});

describe('POST /api/contacts/:contactId/voice-opt-out (spec §8)', () => {
  it('sets + clears voice_opt_out (independent of sms_opt_out)', async () => {
    const world = createFakeWorld();
    const contactId = seedContact(world);
    const { app } = makeWebhookHarness({ world });

    const set = await request(app)
      .post(`/api/contacts/${contactId}/voice-opt-out`)
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ optOut: true });
    expect(set.status).toBe(200);
    expect(set.body.contact.voice_opt_out).toBe(true);
    expect(world.flagWrites.some((w) => w.flag === 'voice_opt_out' && w.value === true)).toBe(true);
    // sms_opt_out is untouched (independent flag).
    expect(world.flagWrites.some((w) => w.flag === 'sms_opt_out')).toBe(false);

    const clear = await request(app)
      .post(`/api/contacts/${contactId}/voice-opt-out`)
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ optOut: false });
    expect(clear.status).toBe(200);
    expect(clear.body.contact.voice_opt_out).toBe(false);
  });

  it('the contact-detail GET surfaces voice_opt_out', async () => {
    const world = createFakeWorld();
    const contactId = seedContact(world, { voice_opt_out: true });
    const { app } = makeWebhookHarness({ world });
    const res = await request(app)
      .get(`/api/contacts/${contactId}`)
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE);
    expect(res.status).toBe(200);
    expect(res.body.contact.voice_opt_out).toBe(true);
  });

  it('404 for an unknown contact', async () => {
    const world = createFakeWorld();
    const { app } = makeWebhookHarness({ world });
    const res = await request(app)
      .post('/api/contacts/nope/voice-opt-out')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ optOut: true });
    expect(res.status).toBe(404);
  });
});
