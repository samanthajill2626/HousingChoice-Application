// Pending-roster-action poller tests (contact-rosters Task 13).
//
// The deferral engine: a roster change confirmed DURING quiet hours becomes a
// pendingRosterActions row due at quiet-end; this poll applies it - or retires
// it with a VISIBLE skip reason when the world moved underneath it (spec 5.3).
//
// Unit-style with the shared in-memory world (helpers/twilioWebhookHarness
// createFakeWorld) so the apply path runs the REAL provision/add services, plus
// PINNED ISO clocks everywhere - no wall clock, no DynamoDB, no network.
//
// Covers, per the plan's Step 1 contract:
//   - poller at quiet-end PROVISIONS a deferred open (intro sent, plan consumed)
//   - poller applies a deferred add WITH the relay.member_added announcement
//   - every skip reason has a scenario: group_closed, owner_canceled,
//     already_member, contact_deleted, member_no_longer_on_roster,
//     roster_too_thin, converted
//   - an unreadable roster/thread is NEVER claimed (A21: it re-lists next tick)
//   - future rows are untouched; a lost claim is benign
import { beforeEach, describe, expect, it } from 'vitest';
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
import { registerRelayFanOutJobHandler } from '../src/jobs/relayFanOut.js';
import { createLogger } from '../src/lib/logger.js';
import type { PoolNumberItem } from '../src/repos/poolNumbersRepo.js';
import type { PoolNumbersService } from '../src/services/poolNumbers.js';
import {
  rosterActionIdFor,
  type PendingRosterActionItem,
} from '../src/repos/pendingRosterActionsRepo.js';
import {
  runDuePendingRosterActions,
  type RunDuePendingRosterActionsDeps,
} from '../src/jobs/rosterActions.js';
import { describeRoster } from '../src/lib/rosterResolution.js';
import { createFakeWorld, type FakeWorld } from './helpers/twilioWebhookHarness.js';
import { createLogCapture } from './helpers/logCapture.js';

// --- pinned clocks ----------------------------------------------------------
// The org window is 21:00 -> 08:00 America/New_York (the default). 23:00 local
// on 2026-07-14 = 03:00Z on the 15th; quiet-end 08:00 local = 12:00Z.
const CONFIRMED_AT = '2026-07-15T03:00:00.000Z'; // 23:00 ET, inside quiet hours
const DUE_AT = '2026-07-15T12:00:00.000Z'; // 08:00 ET, quiet-end
const POLL_AT = '2026-07-15T12:00:30.000Z'; // the first tick after quiet-end

const TENANT_PHONE = '+15550500011';
const OWNER_PHONE = '+15550500012';
const PM_PHONE = '+15550500013';
const CASEWORKER_PHONE = '+15550500021';
const POOL_NUMBER = '+15550509000';

/** No-network pool service: a LIVE add burns the member onto the group's number
 *  (W1) before the roster write, and provisioning assigns one. */
function makeFakePoolNumbers(): PoolNumbersService {
  const rec = (poolNumber: string): PoolNumberItem => ({
    poolNumber,
    lifecycle_state: 'active',
    quarantine_until: '0000-00-00T00:00:00.000Z',
    voice_capable: true,
    sms_capable: true,
    provisioned_at: '2026-07-01T00:00:00.000Z',
  });
  return {
    async provisionForGroup() {
      return { kind: 'assigned', poolNumber: POOL_NUMBER, record: rec(POOL_NUMBER), provisioned: true };
    },
    async noteGroupClosed() {},
    async burnMember() {
      return true;
    },
    async burnGroupRoster() {
      return true;
    },
    async retireEligible() {
      return [];
    },
    async onNumberRegistered() {},
    async warmOneNumber() {},
    async refillBufferIfNeeded() {},
    async flagStuckWarming() {},
    async flagStuckConnecting() {},
    async getRecord(poolNumber) {
      return rec(poolNumber);
    },
    async clearConnectingEarmarks() {},
  };
}

describe('runDuePendingRosterActions (contact-rosters Task 13)', () => {
  let world: FakeWorld;
  let deps: RunDuePendingRosterActionsDeps;
  let queueAdapter: InProcessOutboundQueueAdapter;
  const logger = createLogger({ destination: createLogCapture().stream });

  beforeEach(() => {
    _resetForTests();
    configureJobsLogger(logger);
    configureScheduler(new InMemorySchedulerAdapter());
    world = createFakeWorld();
    registerRelayFanOutJobHandler({
      adapter: world.adapter,
      conversationsRepo: world.conversationsRepo,
      messagesRepo: world.messagesRepo,
      contactsRepo: world.contactsRepo,
      logger,
    });
    queueAdapter = new InProcessOutboundQueueAdapter({ dispatch: dispatchJob });
    configureOutboundQueue(queueAdapter);

    world.contacts.push(
      { contactId: 'c-tenant', type: 'tenant', phone: TENANT_PHONE, firstName: 'Tasha', lastName: 'Tenant' },
      { contactId: 'c-owner', type: 'landlord', phone: OWNER_PHONE, firstName: 'Ollie', lastName: 'Owner' },
      { contactId: 'c-pm', type: 'landlord', phone: PM_PHONE, firstName: 'Pat', lastName: 'Manager' },
      { contactId: 'c-case', type: 'team_member', phone: CASEWORKER_PHONE, firstName: 'Casey', lastName: 'Worker' },
    );
    world.units.set('unit-r', {
      unitId: 'unit-r',
      landlordId: 'c-owner',
      status: 'available',
      contacts: [
        { contactId: 'c-owner', role: 'owner', primaryContact: false },
        { contactId: 'c-pm', role: 'pm', primaryContact: true },
      ],
      primary_contact: 'c-pm',
    });

    deps = {
      actions: world.pendingRosterActionsRepo,
      tours: world.toursRepo,
      placements: world.placementsRepo,
      placementDeadlines: world.placementDeadlinesRepo,
      conversations: world.conversationsRepo,
      contacts: world.contactsRepo,
      units: world.unitsRepo,
      audit: world.auditRepo,
      activityEvents: world.activityEventsRepo,
      poolNumbers: makeFakePoolNumbers(),
      events: world.events,
      // The kill-switch as the deployed env reports it (config.relayLiveProvisioning).
      relayLiveProvisioning: true,
      logger,
    };
  });

  // --- fixtures -------------------------------------------------------------

  async function createTour(
    over: { status?: 'scheduled' | 'canceled' | 'closed'; convertedPlacementId?: string } = {},
  ): Promise<string> {
    const tour = await world.toursRepo.create({
      tenantId: 'c-tenant',
      unitId: 'unit-r',
      scheduledAt: '2026-07-16T14:00:00.000Z',
      tourType: 'landlord_led',
      status: 'scheduled',
    });
    if (over.status !== undefined || over.convertedPlacementId !== undefined) {
      await world.toursRepo.patch(tour.tourId, {
        ...(over.status !== undefined && { status: over.status }),
        ...(over.convertedPlacementId !== undefined && {
          convertedPlacementId: over.convertedPlacementId,
        }),
      });
    }
    return tour.tourId;
  }

  function seedThread(
    conversationId: string,
    participants: { contactId?: string; phone: string; name?: string }[],
    status: 'open' | 'closed' = 'open',
  ): void {
    world.conversations.set(conversationId, {
      conversationId,
      participant_phone: POOL_NUMBER,
      pool_number: POOL_NUMBER,
      status,
      last_activity_at: CONFIRMED_AT,
      type: 'relay_group',
      ai_mode: 'manual',
      participants: participants.map((p) => ({ ...p, contactId: p.contactId ?? '' })),
      created_at: CONFIRMED_AT,
    });
  }

  const openActionId = (ownerType: 'tour' | 'placement', ownerId: string): string =>
    rosterActionIdFor({ ownerType, ownerId, action: 'open_group' });
  const addActionId = (ownerType: 'tour' | 'placement', ownerId: string, contactId: string): string =>
    rosterActionIdFor({ ownerType, ownerId, action: 'add_member', contactId });

  const rowOf = async (actionId: string): Promise<PendingRosterActionItem> => {
    const row = await world.pendingRosterActionsRepo.getById(actionId);
    expect(row, `no pending row ${actionId}`).toBeDefined();
    return row!;
  };

  async function deferOpen(ownerType: 'tour' | 'placement', ownerId: string): Promise<string> {
    const row = await world.pendingRosterActionsRepo.upsertPending({
      ownerType,
      ownerId,
      action: 'open_group',
      dueAt: DUE_AT,
      createdAt: CONFIRMED_AT,
    });
    return row.actionId;
  }

  async function deferAdd(
    ownerType: 'tour' | 'placement',
    ownerId: string,
    contactId: string,
  ): Promise<string> {
    const row = await world.pendingRosterActionsRepo.upsertPending({
      ownerType,
      ownerId,
      action: 'add_member',
      contactId,
      dueAt: DUE_AT,
      createdAt: CONFIRMED_AT,
    });
    return row.actionId;
  }

  // --- open_group: the happy path ------------------------------------------

  it('applies a deferred tour open at quiet-end: provisions, sends the intro, consumes the plan', async () => {
    const tourId = await createTour();
    // A materialized PLAN (tenant + caseworker) - the apply must resolve it AT
    // APPLY TIME and consume it once the pointer is written (D1/D7/A8).
    await world.toursRepo.setRoster(tourId, [{ contactId: 'c-tenant' }, { contactId: 'c-case' }], undefined);
    const actionId = await deferOpen('tour', tourId);
    world.sent.length = 0;

    await runDuePendingRosterActions(POLL_AT, deps);
    await queueAdapter.settle();

    const tour = await world.toursRepo.get(tourId);
    expect(tour!.groupThreadId).toBeDefined();
    expect(tour!.roster, 'the plan is CONSUMED after the pointer write').toBeUndefined();

    const conv = world.conversations.get(tour!.groupThreadId!);
    expect(conv!.type).toBe('relay_group');
    expect((conv!.participants ?? []).map((p) => p.phone).sort()).toEqual(
      [TENANT_PHONE, CASEWORKER_PHONE].sort(),
    );
    // The intro really went out (relay.intro fan-out through the world adapter).
    expect(world.sent.length).toBeGreaterThan(0);
    expect(world.sent.map((s) => s.to).sort()).toEqual([TENANT_PHONE, CASEWORKER_PHONE].sort());

    const row = await rowOf(actionId);
    expect(row.status).toBe('applied');
    expect(row.resolvedAt).toBe(POLL_AT);
  });

  it('applies a deferred placement open at quiet-end', async () => {
    const placement = await world.placementsRepo.create({
      tenantId: 'c-tenant',
      unitId: 'unit-r',
      stage: 'awaiting_approval',
    });
    const actionId = await deferOpen('placement', placement.placementId);
    world.sent.length = 0;

    await runDuePendingRosterActions(POLL_AT, deps);
    await queueAdapter.settle();

    const updated = await world.placementsRepo.getById(placement.placementId);
    expect(updated!.group_thread).toBeDefined();
    expect(world.sent.map((s) => s.to).sort()).toEqual([TENANT_PHONE, PM_PHONE].sort());
    expect((await rowOf(actionId)).status).toBe('applied');
  });

  it('leaves a NOT-YET-DUE row alone', async () => {
    const tourId = await createTour();
    await deferOpen('tour', tourId);

    await runDuePendingRosterActions('2026-07-15T11:59:00.000Z', deps);
    await queueAdapter.settle();

    expect((await rowOf(openActionId('tour', tourId))).status).toBe('pending');
    expect((await world.toursRepo.get(tourId))!.groupThreadId).toBeUndefined();
  });

  // --- add_member: the happy path ------------------------------------------

  it('applies a deferred add at quiet-end WITH the relay.member_added announcement', async () => {
    const tourId = await createTour();
    seedThread('conv-live', [
      { contactId: 'c-tenant', phone: TENANT_PHONE, name: 'Tasha Tenant' },
      { contactId: 'c-pm', phone: PM_PHONE, name: 'Pat Manager' },
    ]);
    await world.toursRepo.patch(tourId, { groupThreadId: 'conv-live' });
    const actionId = await deferAdd('tour', tourId, 'c-case');
    world.sent.length = 0;

    await runDuePendingRosterActions(POLL_AT, deps);
    await queueAdapter.settle();

    const conv = world.conversations.get('conv-live');
    expect(conv!.participants!.map((p) => p.contactId)).toContain('c-case');
    // Everyone on the thread hears the join notice (the member_added fan-out).
    expect(world.sent.map((s) => s.to).sort()).toEqual(
      [TENANT_PHONE, PM_PHONE, CASEWORKER_PHONE].sort(),
    );
    expect((await rowOf(actionId)).status).toBe('applied');
  });

  // --- skip reasons ---------------------------------------------------------

  it('skips group_closed: the thread was CLOSED while the add was pending', async () => {
    const tourId = await createTour();
    seedThread('conv-live', [
      { contactId: 'c-tenant', phone: TENANT_PHONE },
      { contactId: 'c-pm', phone: PM_PHONE },
    ], 'closed');
    await world.toursRepo.patch(tourId, { groupThreadId: 'conv-live' });
    const actionId = await deferAdd('tour', tourId, 'c-case');
    world.sent.length = 0;

    await runDuePendingRosterActions(POLL_AT, deps);
    await queueAdapter.settle();

    const row = await rowOf(actionId);
    expect(row.status).toBe('skipped');
    expect(row.skippedReason).toBe('group_closed');
    expect(world.conversations.get('conv-live')!.participants!.map((p) => p.contactId)).not.toContain('c-case');
    expect(world.sent).toHaveLength(0);
  });

  it('skips group_closed: a deferred OPEN whose group was opened AND closed meanwhile', async () => {
    const tourId = await createTour();
    const actionId = await deferOpen('tour', tourId);
    seedThread('conv-live', [{ contactId: 'c-tenant', phone: TENANT_PHONE }], 'closed');
    await world.toursRepo.patch(tourId, { groupThreadId: 'conv-live' });

    await runDuePendingRosterActions(POLL_AT, deps);
    await queueAdapter.settle();

    const row = await rowOf(actionId);
    expect(row.status).toBe('skipped');
    expect(row.skippedReason).toBe('group_closed');
  });

  it('retires a deferred OPEN as applied (no-op) when a group is ALREADY open', async () => {
    const tourId = await createTour();
    const actionId = await deferOpen('tour', tourId);
    seedThread('conv-live', [
      { contactId: 'c-tenant', phone: TENANT_PHONE },
      { contactId: 'c-pm', phone: PM_PHONE },
    ]);
    await world.toursRepo.patch(tourId, { groupThreadId: 'conv-live' });
    world.sent.length = 0;

    await runDuePendingRosterActions(POLL_AT, deps);
    await queueAdapter.settle();

    expect((await rowOf(actionId)).status).toBe('applied');
    // Nothing was provisioned a SECOND time and nobody was texted again.
    expect(world.sent).toHaveLength(0);
    expect((await world.toursRepo.get(tourId))!.groupThreadId).toBe('conv-live');
  });

  it('skips owner_canceled: the tour was canceled while the open was pending', async () => {
    const tourId = await createTour();
    const actionId = await deferOpen('tour', tourId);
    await world.toursRepo.patch(tourId, { status: 'canceled' });

    await runDuePendingRosterActions(POLL_AT, deps);
    await queueAdapter.settle();

    const row = await rowOf(actionId);
    expect(row.status).toBe('skipped');
    expect(row.skippedReason).toBe('owner_canceled');
    expect((await world.toursRepo.get(tourId))!.groupThreadId).toBeUndefined();
  });

  it('skips owner_canceled: the placement reached a terminal stage', async () => {
    const placement = await world.placementsRepo.create({
      tenantId: 'c-tenant',
      unitId: 'unit-r',
      stage: 'awaiting_approval',
    });
    const actionId = await deferOpen('placement', placement.placementId);
    await world.placementsRepo.update(placement.placementId, { stage: 'lost' });

    await runDuePendingRosterActions(POLL_AT, deps);
    await queueAdapter.settle();

    const row = await rowOf(actionId);
    expect(row.status).toBe('skipped');
    expect(row.skippedReason).toBe('owner_canceled');
  });

  it('skips owner_canceled: the owner row is gone entirely', async () => {
    const actionId = await deferOpen('tour', 'tour-vanished');

    await runDuePendingRosterActions(POLL_AT, deps);
    await queueAdapter.settle();

    const row = await rowOf(actionId);
    expect(row.status).toBe('skipped');
    expect(row.skippedReason).toBe('owner_canceled');
  });

  it('skips already_member: the contact joined the thread while the add was pending', async () => {
    const tourId = await createTour();
    const actionId = await deferAdd('tour', tourId, 'c-case');
    seedThread('conv-live', [
      { contactId: 'c-tenant', phone: TENANT_PHONE },
      { contactId: 'c-case', phone: CASEWORKER_PHONE },
    ]);
    await world.toursRepo.patch(tourId, { groupThreadId: 'conv-live' });
    world.sent.length = 0;

    await runDuePendingRosterActions(POLL_AT, deps);
    await queueAdapter.settle();

    const row = await rowOf(actionId);
    expect(row.status).toBe('skipped');
    expect(row.skippedReason).toBe('already_member');
    // No SECOND join notice for someone already in the group.
    expect(world.sent).toHaveLength(0);
  });

  it('skips contact_deleted: the contact was soft-deleted while the add was pending', async () => {
    const tourId = await createTour();
    seedThread('conv-live', [
      { contactId: 'c-tenant', phone: TENANT_PHONE },
      { contactId: 'c-pm', phone: PM_PHONE },
    ]);
    await world.toursRepo.patch(tourId, { groupThreadId: 'conv-live' });
    const actionId = await deferAdd('tour', tourId, 'c-case');
    await world.contactsRepo.softDelete('c-case', 'va@example.com');

    await runDuePendingRosterActions(POLL_AT, deps);
    await queueAdapter.settle();

    const row = await rowOf(actionId);
    expect(row.status).toBe('skipped');
    expect(row.skippedReason).toBe('contact_deleted');
  });

  it('skips member_no_longer_on_roster: the member was removed DURING the pending window', async () => {
    const tourId = await createTour();
    seedThread('conv-live', [
      { contactId: 'c-tenant', phone: TENANT_PHONE },
      { contactId: 'c-pm', phone: PM_PHONE },
    ]);
    await world.toursRepo.patch(tourId, { groupThreadId: 'conv-live' });
    const actionId = await deferAdd('tour', tourId, 'c-case');
    // They joined and were REMOVED again after the deferral was queued - the
    // removal milestone is the evidence (refId = this thread, at > createdAt).
    await world.activityEventsRepo.record({
      contactId: 'c-case',
      type: 'removed_from_group_text',
      label: 'Removed from group text',
      refType: 'conversation',
      refId: 'conv-live',
      at: '2026-07-15T04:00:00.000Z',
    });
    world.sent.length = 0;

    await runDuePendingRosterActions(POLL_AT, deps);
    await queueAdapter.settle();

    const row = await rowOf(actionId);
    expect(row.status).toBe('skipped');
    expect(row.skippedReason).toBe('member_no_longer_on_roster');
    expect(world.sent).toHaveLength(0);
  });

  it('honors a removal pin buried behind 30+ NEWER events (PL4 - pages to the boundary)', async () => {
    // A busy contact (several tours/placements) can push the removal milestone
    // well past one page of activity inside an 11-hour quiet window. A fixed
    // first-page read would miss it and re-add - AND announce - someone an
    // operator deliberately removed.
    const tourId = await createTour();
    seedThread('conv-live', [
      { contactId: 'c-tenant', phone: TENANT_PHONE },
      { contactId: 'c-pm', phone: PM_PHONE },
    ]);
    await world.toursRepo.patch(tourId, { groupThreadId: 'conv-live' });
    const actionId = await deferAdd('tour', tourId, 'c-case');
    await world.activityEventsRepo.record({
      contactId: 'c-case',
      type: 'removed_from_group_text',
      label: 'Removed from group text',
      refType: 'conversation',
      refId: 'conv-live',
      at: '2026-07-15T04:00:00.000Z', // AFTER the deferral was confirmed
    });
    // 34 milestones NEWER than the removal, all unrelated to this thread.
    for (let i = 0; i < 34; i += 1) {
      await world.activityEventsRepo.record({
        contactId: 'c-case',
        type: 'listing_sent',
        label: 'Listing sent',
        at: `2026-07-15T05:${String(i).padStart(2, '0')}:00.000Z`,
      });
    }
    world.sent.length = 0;

    await runDuePendingRosterActions(POLL_AT, deps);
    await queueAdapter.settle();

    const row = await rowOf(actionId);
    expect(row.status).toBe('skipped');
    expect(row.skippedReason).toBe('member_no_longer_on_roster');
    expect(world.sent).toHaveLength(0);
  });

  it('refuses to text when the scan CANNOT reach the boundary (conservative failure)', async () => {
    // Beyond the page cap there is no evidence either way - so we do NOT send.
    const tourId = await createTour();
    seedThread('conv-live', [
      { contactId: 'c-tenant', phone: TENANT_PHONE },
      { contactId: 'c-pm', phone: PM_PHONE },
    ]);
    await world.toursRepo.patch(tourId, { groupThreadId: 'conv-live' });
    const actionId = await deferAdd('tour', tourId, 'c-case');
    // Every page full of events NEWER than the row, with no removal pin: the
    // scan runs out of pages before it can prove the member was NOT removed.
    for (let i = 0; i < 260; i += 1) {
      await world.activityEventsRepo.record({
        contactId: 'c-case',
        type: 'listing_sent',
        label: 'Listing sent',
        at: new Date(Date.parse('2026-07-15T04:00:00.000Z') + i * 1000).toISOString(),
      });
    }
    world.sent.length = 0;

    await runDuePendingRosterActions(POLL_AT, deps);
    await queueAdapter.settle();

    const row = await rowOf(actionId);
    expect(row.status).toBe('skipped');
    expect(row.skippedReason).toBe('member_no_longer_on_roster');
    expect(world.sent).toHaveLength(0);
  });

  it('applies an add whose member was removed BEFORE the deferral (a deliberate re-add)', async () => {
    const tourId = await createTour();
    seedThread('conv-live', [
      { contactId: 'c-tenant', phone: TENANT_PHONE },
      { contactId: 'c-pm', phone: PM_PHONE },
    ]);
    await world.toursRepo.patch(tourId, { groupThreadId: 'conv-live' });
    await world.activityEventsRepo.record({
      contactId: 'c-case',
      type: 'removed_from_group_text',
      label: 'Removed from group text',
      refType: 'conversation',
      refId: 'conv-live',
      at: '2026-07-14T18:00:00.000Z', // BEFORE the deferral was confirmed
    });
    const actionId = await deferAdd('tour', tourId, 'c-case');

    await runDuePendingRosterActions(POLL_AT, deps);
    await queueAdapter.settle();

    expect((await rowOf(actionId)).status).toBe('applied');
    expect(
      world.conversations.get('conv-live')!.participants!.map((p) => p.contactId),
    ).toContain('c-case');
  });

  it('skips roster_too_thin: the plan lost its second reachable member', async () => {
    const tourId = await createTour();
    await world.toursRepo.setRoster(tourId, [{ contactId: 'c-tenant' }], undefined);
    const actionId = await deferOpen('tour', tourId);

    await runDuePendingRosterActions(POLL_AT, deps);
    await queueAdapter.settle();

    const row = await rowOf(actionId);
    expect(row.status).toBe('skipped');
    expect(row.skippedReason).toBe('roster_too_thin');
    expect((await world.toursRepo.get(tourId))!.groupThreadId).toBeUndefined();
    // The plan is NOT consumed by a skip - nothing was provisioned.
    expect((await world.toursRepo.get(tourId))!.roster).toBeDefined();
  });

  it('skips converted: the tour became a placement and the migration failed', async () => {
    const tourId = await createTour();
    const actionId = await deferOpen('tour', tourId);
    // The conversion ran; migrate() did NOT (its best-effort call threw), so the
    // row is orphaned on a closed, converted tour.
    await world.toursRepo.patch(tourId, { status: 'closed', convertedPlacementId: 'placement-x' });

    await runDuePendingRosterActions(POLL_AT, deps);
    await queueAdapter.settle();

    const row = await rowOf(actionId);
    expect(row.status).toBe('skipped');
    expect(row.skippedReason).toBe('converted');
  });

  // --- refusals the ACT would raise, pre-empted BEFORE the claim (MF1) ------

  it('skips provisioning_unavailable when live number provisioning is OFF', async () => {
    // The pre-A2P posture (RELAY_LIVE_PROVISIONING=false). The refusal is raised
    // INSIDE provisioning - i.e. after claimApply - where nobody would ever see
    // it: the row would go 'applied' with no group and no notice at all.
    const tourId = await createTour();
    const actionId = await deferOpen('tour', tourId);

    await runDuePendingRosterActions(POLL_AT, { ...deps, relayLiveProvisioning: false });
    await queueAdapter.settle();

    const row = await rowOf(actionId);
    expect(row.status).toBe('skipped');
    expect(row.skippedReason).toBe('provisioning_unavailable');
    expect((await world.toursRepo.get(tourId))!.groupThreadId).toBeUndefined();
    expect(world.sent).toHaveLength(0);
  });

  it('the provisioning_unavailable notice is VISIBLE in the roster payload', async () => {
    const tourId = await createTour();
    await deferOpen('tour', tourId);

    await runDuePendingRosterActions(POLL_AT, { ...deps, relayLiveProvisioning: false });
    await queueAdapter.settle();

    const view = await describeRoster(
      {
        conversations: world.conversationsRepo,
        units: world.unitsRepo,
        contacts: world.contactsRepo,
        actions: world.pendingRosterActionsRepo,
        log: logger,
      },
      { type: 'tour', id: tourId, tenantId: 'c-tenant', unitId: 'unit-r' },
    );
    expect(view.pending).toHaveLength(0);
    expect(view.skipped).toHaveLength(1);
    expect(view.skipped[0]?.reason).toBe('provisioning_unavailable');
    expect(view.skipped[0]?.kind).toBe('open_group');
  });

  it('WAITS on a CONNECTING group instead of losing the add (nothing claimed)', async () => {
    // A connecting group has no pool number yet, so relayMembers refuses the add
    // (409 group_connecting) - but that is TRANSIENT, so the row must survive to
    // the next tick rather than be claimed 'applied' with nobody added.
    const tourId = await createTour();
    seedThread('conv-connecting', [
      { contactId: 'c-tenant', phone: TENANT_PHONE },
      { contactId: 'c-pm', phone: PM_PHONE },
    ]);
    world.conversations.get('conv-connecting')!.status = 'connecting';
    await world.toursRepo.patch(tourId, { groupThreadId: 'conv-connecting' });
    const actionId = await deferAdd('tour', tourId, 'c-case');

    await runDuePendingRosterActions(POLL_AT, deps);
    await queueAdapter.settle();

    expect((await rowOf(actionId)).status, 'still pending - the next tick retries').toBe('pending');
    expect(
      world.conversations.get('conv-connecting')!.participants!.map((p) => p.contactId),
    ).not.toContain('c-case');
    expect(world.sent).toHaveLength(0);
  });

  // --- never-claim paths ----------------------------------------------------

  it('leaves the row UNCLAIMED when the thread pointer will not read (A21)', async () => {
    const tourId = await createTour();
    // A pointer at a conversation nobody can load -> resolver 'unavailable'.
    await world.toursRepo.patch(tourId, { groupThreadId: 'conv-missing' });
    const actionId = await deferAdd('tour', tourId, 'c-case');

    await runDuePendingRosterActions(POLL_AT, deps);
    await queueAdapter.settle();

    expect((await rowOf(actionId)).status, 'still pending - the next tick retries').toBe('pending');
  });

  it('isolates a failing row: the rest of the batch still runs', async () => {
    const tourId = await createTour();
    await deferOpen('tour', tourId);
    const goodPlacement = await world.placementsRepo.create({
      tenantId: 'c-tenant',
      unitId: 'unit-r',
      stage: 'awaiting_approval',
    });
    const goodId = await deferOpen('placement', goodPlacement.placementId);
    // The tour read throws for THIS tour only.
    const realGet = world.toursRepo.get.bind(world.toursRepo);
    world.toursRepo.get = async (id: string) => {
      if (id === tourId) throw new Error('dynamo blip');
      return realGet(id);
    };

    await runDuePendingRosterActions(POLL_AT, deps);
    await queueAdapter.settle();

    expect((await rowOf(openActionId('tour', tourId))).status).toBe('pending');
    expect((await rowOf(goodId)).status).toBe('applied');
  });
});
