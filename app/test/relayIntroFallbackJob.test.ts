// primary-contact-integrity spec 5.2 (plan S3.2): the relay INTRO job logs ONE
// INFO line - ids and reason codes only - when it sends the general intro on an
// OWNED conversation. Never for an operator-edited intro, never for an
// ownerless group, and never from the member-added announcement.
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
  RELAY_INTRO_JOB,
  RELAY_MEMBER_ADDED_JOB,
  registerRelayFanOutJobHandler,
} from '../src/jobs/relayFanOut.js';
import { createLogger } from '../src/lib/logger.js';
import type { ConversationItem } from '../src/repos/conversationsRepo.js';
import { createLogCapture, type LogCapture } from './helpers/logCapture.js';
import { createFakeWorld, type FakeWorld } from './helpers/twilioWebhookHarness.js';

const TENANT = '+15550100061';
const LANDLORD = '+15550100062';
const PM = '+15550100063';
const POOL = '+15550109061';
const STAMP = '2026-07-01T00:00:00.000Z';
/** The job's pinned clock: 09:00 New York on 2026-09-07. */
const JOB_NOW = '2026-09-07T13:00:00.000Z';
/** 15:00 New York the NEXT day: a future tour, so the dated tour intro. */
const FUTURE_AT = '2026-09-08T19:00:00.000Z';
/** A week before JOB_NOW: the tour has started, so the general intro. */
const PAST_AT = '2026-08-31T19:00:00.000Z';
const USED = 'relay intro: general intro used';

describe('relay.intro job - the general-intro INFO line (primary-contact-integrity spec 5.2)', () => {
  let world: FakeWorld;
  let outbound: InProcessOutboundQueueAdapter;
  let capture: LogCapture;

  beforeEach(async () => {
    _resetForTests();
    capture = createLogCapture();
    const logger = createLogger({ level: 'info', destination: capture.stream });
    configureJobsLogger(logger);
    configureScheduler(new InMemorySchedulerAdapter());
    world = createFakeWorld();
    registerRelayFanOutJobHandler({
      sendAttemptsRepo: world.sendAttemptsRepo,
      adapter: world.adapter,
      conversationsRepo: world.conversationsRepo,
      messagesRepo: world.messagesRepo,
      contactsRepo: world.contactsRepo,
      unitsRepo: world.unitsRepo,
      toursRepo: world.toursRepo,
      placementsRepo: world.placementsRepo,
      settingsRepo: world.settingsRepo,
      nowIso: JOB_NOW,
      logger,
    });
    outbound = new InProcessOutboundQueueAdapter({ dispatch: dispatchJob });
    configureOutboundQueue(outbound);

    world.contacts.push(
      { contactId: 'c-tenant', type: 'tenant', phone: TENANT, firstName: 'Tina', lastName: 'Tenant' },
      { contactId: 'c-land', type: 'landlord', phone: LANDLORD, firstName: 'Larry', lastName: 'Land' },
      { contactId: 'c-pm', type: 'landlord', phone: PM, firstName: 'Pat', lastName: 'Manager' },
    );
    world.units.set('unit-job', {
      unitId: 'unit-job',
      landlordId: 'c-land',
      status: 'available',
      address: { line1: '77 Peachtree St', city: 'Atlanta', state: 'GA', zip: '30314' },
      contacts: [
        { contactId: 'c-land', role: 'landlord', primaryContact: true },
        { contactId: 'c-pm', role: 'pm', primaryContact: false },
      ],
      created_at: STAMP,
      updated_at: STAMP,
    } as never);
    world.toursMap.set('tour-job', {
      tourId: 'tour-job',
      tenantId: 'c-tenant',
      unitId: 'unit-job',
      scheduledAt: FUTURE_AT,
      status: 'scheduled',
      tourType: 'landlord_led',
      created_at: STAMP,
      updated_at: STAMP,
    } as never);
    await world.settingsRepo.putOrgSettings({ timezone: 'America/New_York' });
  });

  afterEach(() => {
    _resetForTests();
  });

  function seedRelay(owner: ConversationItem['owner'], extra: Partial<ConversationItem> = {}): void {
    const now = '2026-07-10T00:00:00.000Z';
    world.conversations.set('conv-job', {
      conversationId: 'conv-job',
      participant_phone: POOL,
      pool_number: POOL,
      status: 'open',
      last_activity_at: now,
      type: 'relay_group',
      ai_mode: 'manual',
      participants: [
        { contactId: 'c-tenant', phone: TENANT, name: 'Tina Tenant' },
        { contactId: 'c-land', phone: LANDLORD, name: 'Larry Land' },
        { contactId: 'c-pm', phone: PM, name: 'Pat Manager' },
      ],
      ...(owner !== undefined && { owner }),
      created_at: now,
      ...extra,
    });
  }

  function setTourAt(scheduledAt: string): void {
    const tour = world.toursMap.get('tour-job')!;
    world.toursMap.set('tour-job', { ...tour, scheduledAt });
  }

  const usedLines = (): Record<string, unknown>[] => capture.lines.filter((l) => l['msg'] === USED);

  async function runIntro(): Promise<void> {
    await enqueueImmediate(RELAY_INTRO_JOB, { relayConversationId: 'conv-job' });
    await outbound.settle();
  }

  it('a tour that composes its own intro sends it and logs NO fallback line', async () => {
    seedRelay({ type: 'tour', id: 'tour-job' });
    await runIntro();
    expect(world.sent.length).toBeGreaterThan(0);
    for (const sent of world.sent) expect(sent.body).toContain('Putting you in a group text with Larry');
    expect(usedLines()).toHaveLength(0);
  });

  it('a tour whose start has passed: the general intro and ONE INFO line, ids and reason codes only', async () => {
    setTourAt(PAST_AT);
    seedRelay({ type: 'tour', id: 'tour-job' });
    await runIntro();
    expect(world.sent.length).toBeGreaterThan(0);
    for (const sent of world.sent) expect(sent.body).toContain("You're now connected with");
    const lines = usedLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      level: 30,
      conversationId: 'conv-job',
      ownerType: 'tour',
      ownerId: 'tour-job',
      reasons: ['tour_started'],
    });
    // PII (doc Sec 9): never a name or the street.
    const wire = JSON.stringify(lines[0]);
    expect(wire).not.toContain('Peachtree');
    expect(wire).not.toContain('Tina');
    expect(wire).not.toContain('Larry');
    expect(lines[0]).not.toHaveProperty('street');
  });

  it('a placement-owned group logs ownerType placement and its own reasons', async () => {
    world.units.set('unit-bare', {
      unitId: 'unit-bare',
      landlordId: 'c-land',
      status: 'available',
      contacts: [{ contactId: 'c-land', role: 'landlord', primaryContact: true }],
      created_at: STAMP,
      updated_at: STAMP,
    } as never);
    const placement = await world.placementsRepo.create({
      tenantId: 'c-tenant',
      unitId: 'unit-bare',
      stage: 'awaiting_approval',
    });
    seedRelay({ type: 'placement', id: placement.placementId });
    await runIntro();
    const lines = usedLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      conversationId: 'conv-job',
      ownerType: 'placement',
      ownerId: placement.placementId,
      reasons: ['no_street_address'],
    });
  });

  it('an operator-edited intro is sent verbatim and logs NO fallback line', async () => {
    setTourAt(PAST_AT);
    seedRelay({ type: 'tour', id: 'tour-job' }, { intro_body: 'Hand-written by the operator.' });
    await runIntro();
    expect(world.sent.length).toBeGreaterThan(0);
    for (const sent of world.sent) expect(sent.body).toBe('Hand-written by the operator.');
    expect(usedLines()).toHaveLength(0);
  });

  it('an ownerless group sends the general intro and logs NO fallback line', async () => {
    seedRelay(undefined);
    await runIntro();
    expect(world.sent.length).toBeGreaterThan(0);
    for (const sent of world.sent) expect(sent.body).toContain("You're now connected with");
    expect(usedLines()).toHaveLength(0);
  });

  it('the member-added announcement logs NO fallback line, even on a group whose intro falls back', async () => {
    setTourAt(PAST_AT);
    seedRelay({ type: 'tour', id: 'tour-job' });
    await enqueueImmediate(RELAY_MEMBER_ADDED_JOB, {
      relayConversationId: 'conv-job',
      addedMemberKey: 'c-pm',
    });
    await outbound.settle();
    expect(world.sent.length).toBeGreaterThan(0);
    expect(usedLines()).toHaveLength(0);
  });
});
