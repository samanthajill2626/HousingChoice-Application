// call.missedAutoText (M1.9b) — the milestone golden tests for the zero-tap
// missed-call auto-text job in ISOLATION: settings-gated send through the
// throttled, opt-out-gated send wrapper, and the CallSid idempotency (one
// auto-text per missed call, EVER — even across re-enqueues with different
// jobIds). Driven through the real jobs envelope machinery (enqueueImmediate →
// InProcessOutboundQueue → dispatchJob) so the marker idempotency is exercised
// for real. PII: no caller phone/name in any log line.
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
  enqueueImmediate,
} from '../src/jobs/jobs.js';
import {
  MISSED_CALL_AUTOTEXT_JOB,
  needsMissedCallIntakeText,
  parseMissedCallAutoTextPayload,
  registerMissedCallAutoTextJobHandler,
} from '../src/jobs/missedCallAutoText.js';
import { TokenBucket } from '../src/lib/tokenBucket.js';
import { loadConfig } from '../src/lib/config.js';
import { createLogger } from '../src/lib/logger.js';
import { createSendMessageService } from '../src/services/sendMessage.js';
import type { ConversationItem } from '../src/repos/conversationsRepo.js';
import type { ContactItem } from '../src/repos/contactsRepo.js';
import { createFakeWorld, type FakeWorld } from './helpers/twilioWebhookHarness.js';
import { createLogCapture, type LogCapture } from './helpers/logCapture.js';

const CALLER = '+15550177777';
const CONV_ID = 'conv-caller-1';
const CALL_SID = 'CAmissed0001';

function seedCallerConversation(world: FakeWorld, overrides: Partial<ConversationItem> = {}): void {
  const now = new Date().toISOString();
  world.conversations.set(CONV_ID, {
    conversationId: CONV_ID,
    participant_phone: CALLER,
    status: 'open',
    last_activity_at: now,
    type: 'tenant_1to1',
    ai_mode: 'auto',
    created_at: now,
    ...overrides,
  });
}

/** Give the caller number a contact record so the intake gate can resolve it. */
function seedCallerContact(world: FakeWorld, fields: Record<string, unknown> = {}): void {
  world.contacts.push({
    contactId: 'contact-caller-1',
    type: 'unknown',
    phone: CALLER,
    ...fields,
  } as ContactItem);
}

describe('call.missedAutoText (M1.9b)', () => {
  let world: FakeWorld;
  let capture: LogCapture;
  // Immediate dispatch now DEFERS (SQS semantics) - settle() drains the run.
  let queueAdapter: InProcessOutboundQueueAdapter;

  beforeEach(() => {
    _resetForTests();
    capture = createLogCapture();
    const logger = createLogger({ level: 'info', destination: capture.stream });
    configureJobsLogger(logger);
    configureScheduler(new InMemorySchedulerAdapter());
    world = createFakeWorld();
    seedCallerConversation(world);
    registerMissedCallAutoTextJobHandler({
      settingsRepo: world.settingsRepo,
      messagesRepo: world.messagesRepo,
      conversationsRepo: world.conversationsRepo,
      contactsRepo: world.contactsRepo,
      sendMessageService: createSendMessageService({
        config: loadConfig({ NODE_ENV: 'test', BUSINESS_PHONE_NUMBER: '+15550009999' } as NodeJS.ProcessEnv),
        logger,
        adapter: world.adapter,
        conversationsRepo: world.conversationsRepo,
        messagesRepo: world.messagesRepo,
        contactsRepo: world.contactsRepo,
        auditRepo: world.auditRepo,
        events: world.events,
      }),
      tokenBucket: new TokenBucket({ capacity: 5, refillPerSec: 5 }),
      logger,
    });
    queueAdapter = new InProcessOutboundQueueAdapter({ dispatch: dispatchJob });
    configureOutboundQueue(queueAdapter);
  });

  afterEach(async () => {
    await queueAdapter.settle();
    _resetForTests();
  });

  it('enabled → sends the auto-text into the caller conversation (automated)', async () => {
    await enqueueImmediate(MISSED_CALL_AUTOTEXT_JOB, { callSid: CALL_SID, conversationId: CONV_ID });
    await queueAdapter.settle();

    expect(world.sent).toHaveLength(1);
    expect(world.sent[0]!.to).toBe(CALLER);
    expect(world.sent[0]!.body).toBe(world.settings.missedCallAutoText);
    // Persisted outbound message authored by the team, automated.
    const msg = world.messages.find((m) => m.conversationId === CONV_ID && m.direction === 'outbound');
    expect(msg?.author).toBe('teammate');
  });

  it('disabled in settings → marks done + skips (no send)', async () => {
    world.settings.missedCallAutoTextEnabled = false;
    await enqueueImmediate(MISSED_CALL_AUTOTEXT_JOB, { callSid: CALL_SID, conversationId: CONV_ID });
    await queueAdapter.settle();
    expect(world.sent).toHaveLength(0);
  });

  it('caller opted out → SendRefusedError → skipped, NOT retried', async () => {
    seedCallerConversation(world, { sms_opt_out: true });
    await enqueueImmediate(MISSED_CALL_AUTOTEXT_JOB, { callSid: CALL_SID, conversationId: CONV_ID });
    await queueAdapter.settle();
    expect(world.sent).toHaveLength(0);
  });

  it('GUARDRAIL: idempotent per CallSid — re-enqueue (fresh jobId) never double-sends', async () => {
    await enqueueImmediate(MISSED_CALL_AUTOTEXT_JOB, { callSid: CALL_SID, conversationId: CONV_ID });
    await queueAdapter.settle();
    // A redelivered status callback enqueues a SECOND job with a different
    // jobId; the CallSid marker (not the jobId) is the dedupe key.
    await enqueueImmediate(MISSED_CALL_AUTOTEXT_JOB, { callSid: CALL_SID, conversationId: CONV_ID });
    await queueAdapter.settle();
    await enqueueImmediate(MISSED_CALL_AUTOTEXT_JOB, { callSid: CALL_SID, conversationId: CONV_ID });
    await queueAdapter.settle();
    expect(world.sent).toHaveLength(1);
    // The CallSid marker was claimed exactly once.
    expect(world.jobExecutionMarkers.has(CALL_SID)).toBe(true);
  });

  it('never logs the caller phone (PII, doc §9)', async () => {
    await enqueueImmediate(MISSED_CALL_AUTOTEXT_JOB, { callSid: CALL_SID, conversationId: CONV_ID });
    await queueAdapter.settle();
    expect(JSON.stringify(capture.lines)).not.toContain(CALLER);
  });

  // --- INTAKE GATE (2026-08-19) --------------------------------------------
  // The copy asks for full name, voucher size, and housing authority, so it may
  // only go to a caller we hold NONE of that on. The default fixture seeds no
  // contact at all, which is the first-time caller - covered by the 'enabled'
  // test above and re-asserted explicitly here.

  it('gate: no contact record at all (first-time caller) - sends', async () => {
    expect(world.contacts).toHaveLength(0);
    await enqueueImmediate(MISSED_CALL_AUTOTEXT_JOB, { callSid: CALL_SID, conversationId: CONV_ID });
    await queueAdapter.settle();
    expect(world.sent).toHaveLength(1);
  });

  it('gate: unadjudicated caller with a blank profile - sends (founder ruling)', async () => {
    seedCallerContact(world, { type: 'unknown', status: 'needs_review' });
    await enqueueImmediate(MISSED_CALL_AUTOTEXT_JOB, { callSid: CALL_SID, conversationId: CONV_ID });
    await queueAdapter.settle();
    expect(world.sent).toHaveLength(1);
  });

  it('gate: tenant with the full intake profile - skips', async () => {
    seedCallerContact(world, {
      type: 'tenant',
      firstName: 'Destiny',
      lastName: 'Cole',
      voucherSize: 2,
      housingAuthority: 'Fulton County',
    });
    await enqueueImmediate(MISSED_CALL_AUTOTEXT_JOB, { callSid: CALL_SID, conversationId: CONV_ID });
    await queueAdapter.settle();
    expect(world.sent).toHaveLength(0);
  });

  it('gate: ONE fact on file is enough to skip (partial re-ask is deferred)', async () => {
    seedCallerContact(world, { type: 'unknown', firstName: 'Destiny' });
    await enqueueImmediate(MISSED_CALL_AUTOTEXT_JOB, { callSid: CALL_SID, conversationId: CONV_ID });
    await queueAdapter.settle();
    expect(world.sent).toHaveLength(0);
  });

  it('gate: landlord with a blank profile - skips (never asked for a voucher)', async () => {
    seedCallerContact(world, { type: 'landlord', status: 'active' });
    await enqueueImmediate(MISSED_CALL_AUTOTEXT_JOB, { callSid: CALL_SID, conversationId: CONV_ID });
    await queueAdapter.settle();
    expect(world.sent).toHaveLength(0);
  });

  it('gate: skip logs the contact type but never the caller phone', async () => {
    seedCallerContact(world, { type: 'landlord' });
    await enqueueImmediate(MISSED_CALL_AUTOTEXT_JOB, { callSid: CALL_SID, conversationId: CONV_ID });
    await queueAdapter.settle();
    const logged = JSON.stringify(capture.lines);
    expect(logged).toContain('intake details already on file');
    expect(logged).not.toContain(CALLER);
  });

  describe('needsMissedCallIntakeText (pure)', () => {
    const contact = (over: Record<string, unknown>): ContactItem =>
      ({ contactId: 'c1', type: 'unknown', ...over }) as ContactItem;

    it('no contact - send', () => {
      expect(needsMissedCallIntakeText(undefined)).toBe(true);
    });

    it('blank tenant/unknown - send', () => {
      expect(needsMissedCallIntakeText(contact({ type: 'unknown' }))).toBe(true);
      expect(needsMissedCallIntakeText(contact({ type: 'tenant' }))).toBe(true);
    });

    it('any single fact present - skip', () => {
      for (const field of ['firstName', 'lastName', 'housingAuthority']) {
        expect(needsMissedCallIntakeText(contact({ [field]: 'x' }))).toBe(false);
      }
      expect(needsMissedCallIntakeText(contact({ voucherSize: 3 }))).toBe(false);
    });

    it('TRAP: voucherSize 0 is a studio, NOT a blank field - skip', () => {
      expect(needsMissedCallIntakeText(contact({ voucherSize: 0 }))).toBe(false);
    });

    it('whitespace-only and non-scalar values do NOT count as on file - send', () => {
      expect(needsMissedCallIntakeText(contact({ firstName: '   ' }))).toBe(true);
      expect(needsMissedCallIntakeText(contact({ firstName: null }))).toBe(true);
      expect(needsMissedCallIntakeText(contact({ voucherSize: Number.NaN }))).toBe(true);
      expect(needsMissedCallIntakeText(contact({ housingAuthority: { v: 1 } }))).toBe(true);
    });

    it('landlord/partner/team member - skip regardless of blank fields', () => {
      for (const type of ['landlord', 'partner', 'team_member']) {
        expect(needsMissedCallIntakeText(contact({ type }))).toBe(false);
      }
    });
  });

  it('parseMissedCallAutoTextPayload rejects a malformed payload', () => {
    expect(() => parseMissedCallAutoTextPayload({})).toThrow();
    expect(() => parseMissedCallAutoTextPayload({ callSid: 'x' })).toThrow();
    expect(() => parseMissedCallAutoTextPayload({ conversationId: 'c' })).toThrow();
    expect(parseMissedCallAutoTextPayload({ callSid: 'x', conversationId: 'c' })).toEqual({
      callSid: 'x',
      conversationId: 'c',
    });
  });
});
