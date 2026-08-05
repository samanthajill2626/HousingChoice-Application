// Tour reminders integration tests against DynamoDB Local (Tours feature, Task 4).
//
// Covers:
//   1. armTourReminders — correct ladder dueAts, past rows skipped
//   2. runDueTourReminders — sends due reminders, stamps sentAt (idempotency)
//   3. reschedule — cancel + re-arm, new dueAts
//   4. cancelTourReminders — pending rows canceled
//   5. same-day tour — day_before skipped (past), future rows armed
//   6. listDue excludes sentAt/canceledAt rows
//   7. [concurrency] two racing runDueTourReminders calls → exactly ONE send
//   8. [concurrency] row canceled after listDue but before claim → zero sends
//
// Uses DynamoDB Local for tourRemindersRepo + toursRepo.
// Uses the in-memory fakeWorld for contacts/conversations/sendMessage adapter.
//
// Self-skipping: when nothing answers at DYNAMODB_ENDPOINT the suite skips.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  MessagingAdapter,
  SendMessageParams,
} from '../src/adapters/messaging.js';
import { tableName } from '../src/lib/config.js';
import { createDocumentClient, createDynamoClient } from '../src/lib/dynamo.js';
import { deleteTableIfExists, ensureTable } from '../src/lib/dynamoAdmin.js';
import { getTableSpec } from '../src/lib/tables.js';
import { createEventBus } from '../src/lib/events.js';
import { createLogger } from '../src/lib/logger.js';
import type { ConversationParticipant } from '../src/repos/conversationsRepo.js';
import { createTourRemindersRepo, type ReminderKind } from '../src/repos/tourRemindersRepo.js';
import { createToursRepo } from '../src/repos/toursRepo.js';
import { DEFAULT_ORG_SETTINGS } from '../src/repos/settingsRepo.js';
import {
  createSendMessageService,
  SendRefusedError,
  type SendMessageInput,
  type SendMessageOutcome,
  type SendMessageService,
} from '../src/services/sendMessage.js';
import {
  armTourReminders,
  cancelTourReminders,
  forceSendReminder,
  runDueTourReminders,
} from '../src/jobs/tourReminders.js';
import { composeTourReminderBody } from '../src/messages/tourCopy.js';
import { createFakeWorld } from './helpers/twilioWebhookHarness.js';
import { createLogCapture } from './helpers/logCapture.js';
import {
  failingSettingsRepo,
  quietOffSettingsRepo,
  stubSettingsRepo,
} from './helpers/settingsStub.js';

const endpoint = process.env.DYNAMODB_ENDPOINT ?? 'http://localhost:8000';

async function endpointReachable(): Promise<boolean> {
  try {
    await fetch(endpoint, { signal: AbortSignal.timeout(1_500) });
    return true;
  } catch {
    return false;
  }
}

const reachable = await endpointReachable();
if (!reachable) {
  console.warn(
    `[tourReminders.integration] SKIPPED — no DynamoDB Local at ${endpoint}. ` +
      'Run `npm run db:start` to exercise this suite.',
  );
}

/**
 * The body the send paths compose for a rung of a tour booked at `scheduledAt`.
 *
 * Every tour.* default now carries {when}/{time}/{where}, so a bare
 * resolveMessage of one THROWS - the expectation has to be composed from the
 * same context the job composes from. Both settings stubs this suite uses
 * (quietOffSettingsRepo and stubSettingsRepo) inherit
 * DEFAULT_ORG_SETTINGS.timezone, and NO fixture here seeds a unit, so every
 * body takes the _no_address variant.
 */
function rungBody(kind: ReminderKind, scheduledAt: string): string {
  return composeTourReminderBody({ kind, scheduledAt, timezone: DEFAULT_ORG_SETTINGS.timezone });
}

describe.skipIf(!reachable)('tourReminders against DynamoDB Local', () => {
  const testEnv = { TABLE_PREFIX: `hc-test-${randomUUID().slice(0, 8)}-` };
  const client = createDynamoClient({ endpoint });
  const doc = createDocumentClient({ endpoint });
  const logCapture = createLogCapture();
  const logger = createLogger({ destination: logCapture.stream });

  // Real DynamoDB Local repos for persistence.
  const tourReminders = createTourRemindersRepo({ doc, env: testEnv, logger });
  const tours = createToursRepo({ doc, env: testEnv, logger });

  // In-memory fakeWorld for contacts/conversations/sendMessage adapter.
  const world = createFakeWorld();

  // Quiet hours OFF for every test that is NOT about quiet hours: clamping is
  // identity, so these suites keep their original dueAt fixtures (and never
  // depend on where a fixture instant happens to fall in the 21:00-08:00
  // window). The clamp/supersession cases below stub the window explicitly.
  const quietOff = quietOffSettingsRepo();

  // Build a real sendMessageService wired to the fake adapter.
  const sendMessageService = createSendMessageService({
    logger,
    adapter: world.adapter,
    conversationsRepo: world.conversationsRepo,
    messagesRepo: world.messagesRepo,
    contactsRepo: world.contactsRepo,
    auditRepo: world.auditRepo,
    events: world.events,
  });

  // Shared deps for runDueTourReminders. The adapter (group route) is a spy
  // that must stay untouched here — these tours have no group thread (and so
  // is messagesRepo: group rungs persist announcement rows through it).
  const runDeps = {
    tourRemindersRepo: tourReminders,
    toursRepo: tours,
    contactsRepo: world.contactsRepo,
    conversationsRepo: world.conversationsRepo,
    messagesRepo: world.messagesRepo,
    // Address source for the composed body (empty here - these tours' units are
    // never seeded, which is exactly the no-address variant).
    unitsRepo: world.unitsRepo,
    sendMessageService,
    adapter: createAdapterSpy().adapter,
    // Quiet hours OFF: the fire-time backstop is a no-op, so these poller cases
    // keep their original fixture instants. The backstop cases below override
    // this with the default (enabled) window.
    settingsRepo: quietOff,
    logger,
  };

  beforeAll(async () => {
    await ensureTable(client, getTableSpec('tours'), tableName('tours', testEnv));
    await ensureTable(client, getTableSpec('tourReminders'), tableName('tourReminders', testEnv));
  }, 120_000);

  afterAll(async () => {
    await deleteTableIfExists(client, tableName('tours', testEnv));
    await deleteTableIfExists(client, tableName('tourReminders', testEnv));
    doc.destroy();
    client.destroy();
  }, 120_000);

  // ---------------------------------------------------------------------------
  // Test 1 — arm: correct ladder dueAts for a future tour
  // ---------------------------------------------------------------------------
  it('armTourReminders creates all 4 reminder rows with correct dueAts', async () => {
    // Quiet hours ON (the product default: 21:00-08:00 America/New_York, EST =
    // UTC-5 in January). Every rung below lands in daylight, so the clamp is
    // identity - EXCEPT morning_of, which is now 08:00 ORG-LOCAL on the tour's
    // local day (it used to be 08:00 UTC = 3am ET, the motivating bug).
    const now = '2026-01-19T15:00:00.000Z'; // Jan 19 10:00 EST
    const scheduledAt = '2026-01-20T20:00:00.000Z'; // Jan 20 15:00 EST

    const tour = await tours.create({
      tenantId: 'contact-arm-1',
      unitId: 'unit-arm-1',
      scheduledAt,
      tourType: 'self_guided',
    });

    const rows = await armTourReminders(tour, now, {
      tourRemindersRepo: tourReminders,
      settingsRepo: stubSettingsRepo(),
      logger,
    });

    // All 4 armed kinds: confirmation, day_before, morning_of, en_route
    // (no_show_checkin is manual-send only). All dueAts are future relative to now.
    expect(rows).toHaveLength(4);
    const byKind = Object.fromEntries(rows.map((r) => [r.kind, r]));

    // confirmation: dueAt = now (10:00 EST - outside the window, unclamped)
    expect(byKind['confirmation']!.dueAt).toBe(now);

    // day_before: scheduledAt - 24h = Jan 19 15:00 EST (daytime, unclamped)
    expect(byKind['day_before']!.dueAt).toBe('2026-01-19T20:00:00.000Z');

    // morning_of: 08:00 ORG-LOCAL on the tour's local date = Jan 20 08:00 EST
    expect(byKind['morning_of']!.dueAt).toBe('2026-01-20T13:00:00.000Z');

    // en_route: scheduledAt - 2h = Jan 20 13:00 EST (daytime, unclamped)
    expect(byKind['en_route']!.dueAt).toBe('2026-01-20T18:00:00.000Z');

    // no_show_checkin is manual-send only, so it is NOT auto-armed (absent here).
    expect(byKind['no_show_checkin']).toBeUndefined();

    // All rows should have no sentAt/canceledAt
    for (const r of rows) {
      expect(r.sentAt).toBeUndefined();
      expect(r.canceledAt).toBeUndefined();
      expect(r.reminderId).toMatch(/^reminder-/);
      expect(r.tourId).toBe(tour.tourId);
      expect(r._reminderPartition).toBe('reminders');
    }

    // listByTour round-trip
    const listed = await tourReminders.listByTour(tour.tourId);
    expect(listed).toHaveLength(4);
  });

  // ---------------------------------------------------------------------------
  // Test 1b - guard: no_show_checkin is manual-send only, never auto-armed
  // ---------------------------------------------------------------------------
  it('does not auto-arm the no_show_checkin rung (manual send only)', async () => {
    const now = '2026-07-13T10:00:00.000Z';
    // T+2d, full future ladder. The tour is at 14:00 EDT (not 06:00 EDT as it
    // once was): a tour that early would have its 08:00-local morning_of land
    // AFTER the tour start, which the past-event rule now legitimately drops -
    // this case is about the no_show_checkin guard, not about that rule.
    const scheduledAt = '2026-07-15T18:00:00.000Z';

    const tour = await tours.create({
      tenantId: 'contact-noarm-1',
      unitId: 'unit-noarm-1',
      scheduledAt,
      tourType: 'self_guided',
    });

    const rows = await armTourReminders(tour, now, {
      tourRemindersRepo: tourReminders,
      settingsRepo: quietOff,
      logger,
    });
    const kinds = rows.map((r) => r.kind);

    expect(kinds).not.toContain('no_show_checkin');
    expect(kinds).toHaveLength(4);
  });

  // ===========================================================================
  // Arm-time quiet-hours clamping + supersession (quiet-hours spec section 5).
  // Every case pins CONCRETE instants against the default window
  // (21:00-08:00 America/New_York; January = EST = UTC-5), so nothing here
  // depends on the wall clock or on the machine's timezone.
  //
  // Skip rules under test:
  //   (a) past-dueAt        - pre-existing: a clamped dueAt still < now
  //   (b) past-event        - a clamp landing at/after the tour start
  //   (c) same-slot         - an earlier rung clamped onto a later rung's slot
  //   (d) stale day_before  - "tour is tomorrow" landing on the tour's local day
  // ===========================================================================

  // ---------------------------------------------------------------------------
  // Test 1c - (c) a clamped day_before loses its slot to morning_of
  // ---------------------------------------------------------------------------
  it('a day_before clamped onto the morning_of slot is superseded (no day_before row)', async () => {
    const now = '2026-01-19T15:00:00.000Z'; // Jan 19 10:00 EST
    const scheduledAt = '2026-01-21T03:00:00.000Z'; // Jan 20 22:00 EST - a 10pm tour

    const tour = await tours.create({
      tenantId: 'contact-arm-supersede-1',
      unitId: 'unit-arm-supersede-1',
      scheduledAt,
      tourType: 'self_guided',
    });

    const rows = await armTourReminders(tour, now, {
      tourRemindersRepo: tourReminders,
      settingsRepo: stubSettingsRepo(),
      logger,
    });
    const byKind = Object.fromEntries(rows.map((r) => [r.kind, r]));

    // day_before raw = Jan 19 22:00 EST (inside the window) -> clamps to Jan 20
    // 08:00 EST, which IS the morning_of slot (the tour's LOCAL date is Jan 20).
    // The later rung's copy is the current one, so day_before is written as a
    // VISIBLE skipped row (the panel's honest trace), never as a pending rung.
    expect(byKind['day_before']!.skippedAt).toBe(now);
    expect(byKind['day_before']!.skipReason).toBe('quiet_hours_superseded');
    expect(byKind['morning_of']!.dueAt).toBe('2026-01-20T13:00:00.000Z');
    expect(byKind['morning_of']!.skippedAt).toBeUndefined();

    // The rest of the ladder is untouched by the collision.
    expect(byKind['confirmation']!.dueAt).toBe(now);
    expect(byKind['en_route']!.dueAt).toBe('2026-01-21T01:00:00.000Z'); // Jan 20 20:00 EST
    expect(rows).toHaveLength(4);
    expect(rows.filter((r) => r.skippedAt === undefined)).toHaveLength(3);
  });

  // ---------------------------------------------------------------------------
  // Test 1d - (c) an en_route clamped onto the morning_of slot wins it
  // ---------------------------------------------------------------------------
  it('an en_route clamped onto the morning_of slot supersedes morning_of', async () => {
    const now = '2026-01-19T15:00:00.000Z'; // Jan 19 10:00 EST
    const scheduledAt = '2026-01-20T13:30:00.000Z'; // Jan 20 08:30 EST - an early tour

    const tour = await tours.create({
      tenantId: 'contact-arm-supersede-2',
      unitId: 'unit-arm-supersede-2',
      scheduledAt,
      tourType: 'self_guided',
    });

    const rows = await armTourReminders(tour, now, {
      tourRemindersRepo: tourReminders,
      settingsRepo: stubSettingsRepo(),
      logger,
    });
    const byKind = Object.fromEntries(rows.map((r) => [r.kind, r]));

    // en_route raw = Jan 20 06:30 EST (inside the window) -> clamps to 08:00 EST
    // = the morning_of slot. en_route is the LATER rung, so it survives;
    // morning_of stays behind as a VISIBLE skipped row.
    expect(byKind['en_route']!.dueAt).toBe('2026-01-20T13:00:00.000Z');
    expect(byKind['en_route']!.skippedAt).toBeUndefined();
    expect(byKind['morning_of']!.skippedAt).toBe(now);
    expect(byKind['morning_of']!.skipReason).toBe('quiet_hours_superseded');

    // day_before raw = Jan 19 08:30 EST - outside the window, so no clamp, and
    // it is already past `now`: dropped by the pre-existing past-dueAt rule,
    // which stays a SILENT skip (a rung whose moment simply passed pre-booking
    // is unremarkable - only quiet-hours retirements get the visible trace).
    expect(byKind['day_before']).toBeUndefined();
    expect(byKind['confirmation']!.dueAt).toBe(now);
  });

  // ---------------------------------------------------------------------------
  // Test 1e - the confirmation rung clamps out of evening quiet hours
  // ---------------------------------------------------------------------------
  it('a confirmation armed inside quiet hours is clamped to quiet-end, not sent at `now`', async () => {
    const now = '2026-01-19T03:00:00.000Z'; // Jan 18 22:00 EST - staff scheduling late
    const scheduledAt = '2026-01-25T20:00:00.000Z'; // Jan 25 15:00 EST

    const tour = await tours.create({
      tenantId: 'contact-arm-lateclamp-1',
      unitId: 'unit-arm-lateclamp-1',
      scheduledAt,
      tourType: 'self_guided',
    });

    const rows = await armTourReminders(tour, now, {
      tourRemindersRepo: tourReminders,
      settingsRepo: stubSettingsRepo(),
      logger,
    });
    const byKind = Object.fromEntries(rows.map((r) => [r.kind, r]));

    // 22:00 EST is the evening side of the wrapping window: the window ends at
    // 08:00 EST the NEXT local morning.
    expect(byKind['confirmation']!.dueAt).toBe('2026-01-19T13:00:00.000Z');
    expect(byKind['confirmation']!.dueAt).not.toBe(now);
    expect(rows).toHaveLength(4);
  });

  // ---------------------------------------------------------------------------
  // Test 1f - (b) rungs whose clamp lands at/past the tour start are skipped
  // ---------------------------------------------------------------------------
  it('rungs clamped at or past the tour start are skipped (early-morning tour)', async () => {
    // `now` is TWO days out (not one) so day_before's CLAMPED dueAt is still in
    // the future: with a Jan 19 arm time the clamped Jan 19 13:00Z is already
    // past and the pre-existing past-dueAt rule drops it before supersession is
    // ever consulted - that interaction is pinned by Test 1g instead.
    const now = '2026-01-18T15:00:00.000Z'; // Jan 18 10:00 EST
    const scheduledAt = '2026-01-20T12:30:00.000Z'; // Jan 20 07:30 EST

    const tour = await tours.create({
      tenantId: 'contact-arm-pastevent-1',
      unitId: 'unit-arm-pastevent-1',
      scheduledAt,
      tourType: 'self_guided',
    });

    const rows = await armTourReminders(tour, now, {
      tourRemindersRepo: tourReminders,
      settingsRepo: stubSettingsRepo(),
      logger,
    });
    const byKind = Object.fromEntries(rows.map((r) => [r.kind, r]));

    // morning_of (Jan 20 08:00 EST) is at/after the 07:30 EST start -> retired
    // as a VISIBLE skipped row (past_event). en_route raw = Jan 20 05:30 EST
    // (quiet) -> clamps to 08:00 EST, also at/after the start -> same trace.
    expect(byKind['morning_of']!.skippedAt).toBe(now);
    expect(byKind['morning_of']!.skipReason).toBe('past_event');
    expect(byKind['en_route']!.skippedAt).toBe(now);
    expect(byKind['en_route']!.skipReason).toBe('past_event');

    // day_before raw = Jan 19 07:30 EST (quiet) -> clamps to Jan 19 08:00 EST.
    // Its LOCAL date (Jan 19) is not the tour's local date (Jan 20), so the
    // "tour is tomorrow" copy is still true -> armed.
    expect(byKind['day_before']!.dueAt).toBe('2026-01-19T13:00:00.000Z');
    expect(byKind['day_before']!.skippedAt).toBeUndefined();
    expect(
      rows.filter((r) => r.skippedAt === undefined).map((r) => r.kind).sort(),
    ).toEqual(['confirmation', 'day_before']);
  });

  // ---------------------------------------------------------------------------
  // Test 1g - (a) a clamp that still lands before `now` is dropped
  // ---------------------------------------------------------------------------
  it('a rung whose clamped dueAt is still in the past is skipped (past-dueAt rule)', async () => {
    const now = '2026-01-19T15:00:00.000Z'; // Jan 19 10:00 EST
    const scheduledAt = '2026-01-20T12:30:00.000Z'; // Jan 20 07:30 EST

    const tour = await tours.create({
      tenantId: 'contact-arm-pastdue-1',
      unitId: 'unit-arm-pastdue-1',
      scheduledAt,
      tourType: 'self_guided',
    });

    const rows = await armTourReminders(tour, now, {
      tourRemindersRepo: tourReminders,
      settingsRepo: stubSettingsRepo(),
      logger,
    });

    // day_before raw = Jan 19 07:30 EST (quiet) -> clamps to Jan 19 08:00 EST,
    // which is STILL before `now` (10:00 EST) -> past-dueAt (silent, no row).
    // Both same-day rungs clamp at/past the 07:30 start -> past-event, retired
    // as VISIBLE skipped rows. Only confirmation is actually pending.
    const byKind = Object.fromEntries(rows.map((r) => [r.kind, r]));
    expect(byKind['day_before']).toBeUndefined();
    expect(byKind['morning_of']!.skipReason).toBe('past_event');
    expect(byKind['en_route']!.skipReason).toBe('past_event');
    expect(rows.filter((r) => r.skippedAt === undefined).map((r) => r.kind)).toEqual(['confirmation']);
  });

  // ---------------------------------------------------------------------------
  // Test 1h - quiet hours OFF: no clamping, but morning_of stays org-local
  // ---------------------------------------------------------------------------
  it('with quiet hours disabled nothing is clamped, and morning_of is still 08:00 org-local', async () => {
    const now = '2026-01-19T15:00:00.000Z'; // Jan 19 10:00 EST
    const scheduledAt = '2026-01-21T03:00:00.000Z'; // Jan 20 22:00 EST - Test 1c's tour

    const tour = await tours.create({
      tenantId: 'contact-arm-quietoff-1',
      unitId: 'unit-arm-quietoff-1',
      scheduledAt,
      tourType: 'self_guided',
    });

    const rows = await armTourReminders(tour, now, {
      tourRemindersRepo: tourReminders,
      settingsRepo: quietOff,
      logger,
    });
    const byKind = Object.fromEntries(rows.map((r) => [r.kind, r]));

    // The same tour that lost its day_before in Test 1c keeps all 4 rungs: with
    // the window disabled the 22:00 EST day_before stays at 22:00 EST.
    expect(rows).toHaveLength(4);
    expect(byKind['day_before']!.dueAt).toBe('2026-01-20T03:00:00.000Z');
    // morning_of is 08:00 ORG-LOCAL regardless of the window's enabled flag -
    // the timezone comes from the same settings row.
    expect(byKind['morning_of']!.dueAt).toBe('2026-01-20T13:00:00.000Z');
  });

  // ---------------------------------------------------------------------------
  // Test 1i - a settings-read failure falls back to the DEFAULT window
  // ---------------------------------------------------------------------------
  it('a settings read failure still clamps, using the default window', async () => {
    const now = '2026-01-19T15:00:00.000Z';
    const scheduledAt = '2026-01-21T03:00:00.000Z'; // Test 1c's tour again

    const tour = await tours.create({
      tenantId: 'contact-arm-settingsfail-1',
      unitId: 'unit-arm-settingsfail-1',
      scheduledAt,
      tourType: 'self_guided',
    });

    const rows = await armTourReminders(tour, now, {
      tourRemindersRepo: tourReminders,
      settingsRepo: failingSettingsRepo(),
      logger,
    });
    const byKind = Object.fromEntries(rows.map((r) => [r.kind, r]));

    // Identical to Test 1c: the failure falls back to DEFAULT_ORG_SETTINGS
    // (enabled, 21:00-08:00, America/New_York) - never to "no quiet hours".
    expect(byKind['day_before']!.skippedAt).toBe(now);
    expect(byKind['day_before']!.skipReason).toBe('quiet_hours_superseded');
    expect(byKind['morning_of']!.dueAt).toBe('2026-01-20T13:00:00.000Z');
    expect(rows.filter((r) => r.skippedAt === undefined)).toHaveLength(3);
  });

  // ---------------------------------------------------------------------------
  // Test 2 — run: sends due reminders and stamps sentAt; second run is no-op
  // ---------------------------------------------------------------------------
  it('runDueTourReminders sends due rows and is idempotent', async () => {
    // Clear world.sent from prior tests.
    world.sent.length = 0;

    const phone = '+15550200001';
    const contactId = 'contact-run-1';
    const convId = 'conv-run-1';
    const now0 = '2026-07-13T10:00:00.000Z'; // arm time
    const scheduledAt = '2026-07-15T10:00:00.000Z'; // T+2d

    // Seed contact + conversation in the fake world.
    world.contacts.push({
      contactId,
      type: 'tenant',
      phone,
      created_at: now0,
    } as Parameters<typeof world.contacts.push>[0]);
    world.conversations.set(convId, {
      conversationId: convId,
      participant_phone: phone,
      status: 'open',
      type: 'tenant_1to1',
      ai_mode: 'auto',
      last_activity_at: now0,
      created_at: now0,
    });

    const tour = await tours.create({
      tenantId: contactId,
      unitId: 'unit-run-1',
      scheduledAt,
      tourType: 'self_guided',
    });

    // Arm reminders.
    await armTourReminders(tour, now0, {
      tourRemindersRepo: tourReminders,
      settingsRepo: quietOff,
      logger,
    });

    // Tick 1 - just after the confirmation dueAt: that rung alone is due.
    await runDueTourReminders('2026-07-13T10:01:00.000Z', runDeps);

    // Tick 2 - just after day_before dueAt ('2026-07-14T10:00:00.000Z').
    // en_route ('2026-07-15T08:00:00.000Z') is still future.
    // (The two rungs are released by SEPARATE ticks on purpose: one catch-up
    // tick releasing both would hit release supersession - a later rung of the
    // same tour retires the earlier one. That rule has its own case below.)
    const pollAt = '2026-07-14T10:01:00.000Z';
    await runDueTourReminders(pollAt, runDeps);

    // confirmation + day_before fired, one per tick.
    expect(world.sent).toHaveLength(2);
    const sentBodies = world.sent.map((s) => s.body);
    expect(sentBodies).toContain(rungBody('confirmation', scheduledAt));
    expect(sentBodies).toContain(rungBody('day_before', scheduledAt));

    // All sent rows should have sentAt stamped.
    const rows = await tourReminders.listByTour(tour.tourId);
    const confirmation = rows.find((r) => r.kind === 'confirmation');
    const dayBefore = rows.find((r) => r.kind === 'day_before');
    expect(confirmation?.sentAt).toBeDefined();
    expect(dayBefore?.sentAt).toBeDefined();

    // Second run — idempotent: no new sends.
    await runDueTourReminders(pollAt, runDeps);
    expect(world.sent).toHaveLength(2); // unchanged
  });

  // ---------------------------------------------------------------------------
  // Test 2b — a fired rung emits scheduled.updated (the live Reminders panel /
  // Upcoming bucket refetch on it; reaches SSE clients when the poll runs in
  // the app process — the dev tick / e2e seam)
  // ---------------------------------------------------------------------------
  it('runDueTourReminders emits scheduled.updated per claimed rung (advisory tenant contactId)', async () => {
    world.sent.length = 0;
    const phone = '+15550200002';
    const contactId = 'contact-emit-1';
    const convId = 'conv-emit-1';
    const now0 = '2026-07-13T10:00:00.000Z';
    const scheduledAt = '2026-07-15T10:00:00.000Z';

    world.contacts.push({
      contactId,
      type: 'tenant',
      phone,
      created_at: now0,
    } as Parameters<typeof world.contacts.push>[0]);
    world.conversations.set(convId, {
      conversationId: convId,
      participant_phone: phone,
      status: 'open',
      type: 'tenant_1to1',
      ai_mode: 'auto',
      last_activity_at: now0,
      created_at: now0,
    });
    const tour = await tours.create({
      tenantId: contactId,
      unitId: 'unit-emit-1',
      scheduledAt,
      tourType: 'self_guided',
    });
    await armTourReminders(tour, now0, {
      tourRemindersRepo: tourReminders,
      settingsRepo: quietOff,
      logger,
    });

    const events = createEventBus({ logger });
    const emitted: Array<{ contactId?: string }> = [];
    events.on('scheduled.updated', (p) => emitted.push(p));

    // Same two ticks as Test 2 (separate releases - see the supersession note
    // there): confirmation fires on the first, day_before on the second.
    await runDueTourReminders('2026-07-13T10:01:00.000Z', { ...runDeps, events });
    await runDueTourReminders('2026-07-14T10:01:00.000Z', { ...runDeps, events });
    expect(emitted).toHaveLength(2);
    for (const p of emitted) expect(p.contactId).toBe(contactId);

    // Idempotent second run: nothing claims → nothing emits.
    await runDueTourReminders('2026-07-14T10:01:00.000Z', { ...runDeps, events });
    expect(emitted).toHaveLength(2);
  });

  // ---------------------------------------------------------------------------
  // Test 2c — a due rung the poll cannot deliver is CLAIM-SKIPPED (retired
  // unsent): stamped skippedAt + skipReason, gone from listDue (no perpetual
  // re-list/re-skip every 60s), never claimable for a send afterwards, and the
  // skip emits scheduled.updated so an open Reminders panel flips its chip.
  // ---------------------------------------------------------------------------
  it('claim-skips a due rung whose tenant has no 1:1 conversation (terminal, emits, leaves listDue)', async () => {
    world.sent.length = 0;

    const contactId = 'contact-skip-1';
    const now0 = '2026-07-13T10:00:00.000Z';
    const scheduledAt = '2026-07-15T10:00:00.000Z';

    // Contact exists WITH a phone — but NO conversation in the world.
    world.contacts.push({
      contactId,
      type: 'tenant',
      phone: '+15550200099',
      created_at: now0,
    } as Parameters<typeof world.contacts.push>[0]);

    const tour = await tours.create({
      tenantId: contactId,
      unitId: 'unit-skip-1',
      scheduledAt,
      tourType: 'self_guided',
    });
    await armTourReminders(tour, now0, {
      tourRemindersRepo: tourReminders,
      settingsRepo: quietOff,
      logger,
    });

    const events = createEventBus({ logger });
    const emitted: Array<{ contactId?: string }> = [];
    events.on('scheduled.updated', (p) => emitted.push(p));

    // Only the confirmation rung (dueAt = now0) is due in this window.
    const pollAt = '2026-07-13T10:01:00.000Z';
    await runDueTourReminders(pollAt, { ...runDeps, events });

    // Nothing sent; the rung is retired with the stamp + reason.
    expect(world.sent).toHaveLength(0);
    const rows = await tourReminders.listByTour(tour.tourId);
    const confirmation = rows.find((r) => r.kind === 'confirmation');
    expect(confirmation?.sentAt).toBeUndefined();
    expect(confirmation?.skippedAt).toBe(pollAt);
    expect(confirmation?.skipReason).toBe('no_conversation');

    // The skip told live surfaces to refetch (advisory tenant contactId).
    expect(emitted.filter((p) => p.contactId === contactId)).toHaveLength(1);

    // Retired = gone from listDue: the next poll has nothing to re-skip …
    const due = await tourReminders.listDue(pollAt);
    expect(due.find((r) => r.reminderId === confirmation!.reminderId)).toBeUndefined();

    // … and the row can never be claimed for a send later (terminal).
    await expect(tourReminders.claimSend(confirmation!.reminderId, pollAt)).resolves.toBe(false);
  });

  // ---------------------------------------------------------------------------
  // sentBody - the body composed for the send that CLAIMED the row, snapshotted
  // so a later reschedule or address edit cannot rewrite what was already sent.
  // The third parameter is OPTIONAL: a two-arg claim is the legacy shape (and
  // the shape every pre-existing caller in this repo still uses), and it must
  // leave the attribute absent rather than writing an empty string.
  // ---------------------------------------------------------------------------
  it('claimSend stores the composed body on the row (and stays optional)', async () => {
    const tour = await tours.create({
      tenantId: 'contact-sentbody-1',
      unitId: 'unit-sentbody-1',
      scheduledAt: '2026-09-10T18:00:00.000Z',
      tourType: 'self_guided',
    });
    const withBody = await tourReminders.create({
      tourId: tour.tourId, kind: 'confirmation', dueAt: '2026-09-01T15:00:00.000Z',
    });
    const withoutBody = await tourReminders.create({
      tourId: tour.tourId, kind: 'day_before', dueAt: '2026-09-09T18:00:00.000Z',
    });

    expect(await tourReminders.claimSend(withBody.reminderId, '2026-09-01T15:00:01.000Z', 'Body text'))
      .toBe(true);
    // Two-arg call: the legacy shape every existing caller uses.
    expect(await tourReminders.claimSend(withoutBody.reminderId, '2026-09-09T18:00:01.000Z'))
      .toBe(true);

    const rows = await tourReminders.listByTour(tour.tourId);
    expect(rows.find((r) => r.reminderId === withBody.reminderId)?.sentBody).toBe('Body text');
    expect(rows.find((r) => r.reminderId === withoutBody.reminderId)?.sentBody).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // COMPOSE-ABOVE-THE-CLAIM containment. The body is composed from the tour's
  // scheduledAt, and a tour can lose a usable one (a bad write, a legacy row);
  // the composer THROWS on that. claimSend IS the sentAt stamp, so the compose
  // must happen ABOVE it - and its failure must be a claim-SKIP, not an escape
  // into the per-row catch, which would leave the row unclaimed and re-listed
  // by every 60s tick forever (the perpetual "sending shortly" bug).
  //
  // Its own January-05 timeline: every other fixture in this file is due on
  // 2026-01-14 or later, so this poll's batch is exactly this one row.
  // ---------------------------------------------------------------------------
  it('a rung whose scheduledAt is unusable is claim-skipped, NOT retried forever', async () => {
    world.sent.length = 0;
    const contactId = 'contact-badsched-1';
    const phone = '+15550200077';
    const convId = 'conv-badsched-1';
    const seededAt = '2026-01-05T00:00:00.000Z';
    // A RESOLVABLE 1:1 target: the failure under test is the COMPOSE, not the
    // target resolution (which claim-skips with its own reasons well before it).
    world.contacts.push({
      contactId,
      type: 'tenant',
      phone,
      created_at: seededAt,
    } as Parameters<typeof world.contacts.push>[0]);
    world.conversations.set(convId, {
      conversationId: convId,
      participant_phone: phone,
      status: 'open',
      type: 'tenant_1to1',
      ai_mode: 'auto',
      last_activity_at: seededAt,
      created_at: seededAt,
    });

    const tour = await tours.create({
      tenantId: contactId,
      unitId: 'unit-badsched-1',
      scheduledAt: '2026-01-06T18:00:00.000Z',
      tourType: 'self_guided',
    });
    const row = await tourReminders.create({
      tourId: tour.tourId,
      kind: 'confirmation',
      dueAt: '2026-01-05T15:00:00.000Z',
    });
    // Corrupt the tour's time AFTER arming - the only way to reach this state.
    // The method is patch(), NOT update() - toursRepo has no update.
    await tours.patch(tour.tourId, { scheduledAt: 'not-an-instant' });

    const pollAt = '2026-01-05T15:00:01.000Z';
    await runDueTourReminders(pollAt, runDeps);

    const after = (await tourReminders.listByTour(tour.tourId))
      .find((r) => r.reminderId === row.reminderId);
    expect(after?.skippedAt).toBe(pollAt);
    expect(after?.skipReason).toBe('invalid_schedule');
    expect(after?.sentAt).toBeUndefined();
    expect(world.sent).toHaveLength(0);

    // The point of the claim-skip: it leaves listDue permanently.
    expect((await tourReminders.listDue('2026-01-05T15:10:00.000Z'))
      .some((r) => r.reminderId === row.reminderId)).toBe(false);
  });

  // ===========================================================================
  // FIRE-TIME BACKSTOP (quiet-hours spec 2026-08-03, section 6)
  //
  // These cases live on their OWN January timeline (2026-01-15), so no row from
  // any other test in this file is ever due at their polls, and each uses a
  // FRESH world (createGroupTestRig) so send counts are isolated. Rows are
  // written straight to the repo with in-window dueAts - exactly the LEGACY
  // shape the backstop exists for (rows armed before clamping shipped, plus
  // worker-downtime catch-up). America/New_York is UTC-5 (EST) in January.
  // ===========================================================================

  /** The product default window: enabled, 21:00-08:00 America/New_York. */
  const quietOnDeps = <T extends object>(deps: T) => ({ ...deps, settingsRepo: stubSettingsRepo() });

  // ---------------------------------------------------------------------------
  // Test 2d - a due rung inside the window is DEFERRED, never claimed
  // ---------------------------------------------------------------------------
  it('defers a due rung while `now` is inside quiet hours WITHOUT claiming it, then sends it after the window', async () => {
    const rig = createGroupTestRig();
    const deps = quietOnDeps(rig.deps);
    const tenantPhone = '+15550210001';
    const armedAt = '2026-01-14T15:00:00.000Z';
    seedTenant(rig.world, 'contact-quiet-1', tenantPhone, 'conv-quiet-1', armedAt);

    const tour = await tours.create({
      tenantId: 'contact-quiet-1',
      unitId: 'unit-quiet-1',
      scheduledAt: '2026-01-15T20:00:00.000Z',
      tourType: 'self_guided',
    });
    // The pre-feature 08:00-UTC morning_of dueAt = 03:00 EST: arm-time clamping
    // would never produce it, so only the backstop can stop it.
    const legacy = await tourReminders.create({
      tourId: tour.tourId,
      kind: 'morning_of',
      dueAt: '2026-01-15T08:00:00.000Z',
    });

    const inWindow = '2026-01-15T09:00:00.000Z'; // Jan 15 04:00 EST
    await runDueTourReminders(inWindow, deps);

    // Nothing sent on either route.
    expect(rig.world.sent).toHaveLength(0);
    expect(rig.groupSends).toHaveLength(0);
    // NOT claimed: claimSend IS the sentAt stamp, so a post-claim refusal would
    // destroy the message. The defer leaves every terminal marker unset.
    const deferred = (await tourReminders.listByTour(tour.tourId)).find(
      (r) => r.reminderId === legacy.reminderId,
    );
    expect(deferred?.sentAt).toBeUndefined();
    expect(deferred?.skippedAt).toBeUndefined();
    expect(deferred?.canceledAt).toBeUndefined();
    // Still live in listDue - it re-fires on the next tick.
    expect((await tourReminders.listDue(inWindow)).map((r) => r.reminderId)).toContain(
      legacy.reminderId,
    );

    // One tick past quiet-end (08:05 EST) - the deferred rung goes out.
    const afterWindow = '2026-01-15T13:05:00.000Z';
    await runDueTourReminders(afterWindow, deps);
    expect(rig.world.sent).toHaveLength(1);
    expect(rig.world.sent[0]!.body).toBe(rungBody('morning_of', '2026-01-15T20:00:00.000Z'));
    expect(
      (await tourReminders.listByTour(tour.tourId)).find((r) => r.reminderId === legacy.reminderId)
        ?.sentAt,
    ).toBe(afterWindow);
  });

  // ---------------------------------------------------------------------------
  // Test 2e - the backstop sits ABOVE the group branch, so GROUP-routed rungs
  // (landlord_led / pm_team) are covered too
  // ---------------------------------------------------------------------------
  it('defers a GROUP-routed rung as well (the check runs before the tourType branch)', async () => {
    const rig = createGroupTestRig();
    const deps = quietOnDeps(rig.deps);
    const now0 = '2026-01-14T15:00:00.000Z';
    const tenantPhone = '+15550210002';
    const landlordPhone = '+15550210012';
    const poolNumber = '+15550190021';
    const groupConvId = 'conv-group-quiet-1';

    seedTenant(rig.world, 'contact-quiet-2', tenantPhone, 'conv-1to1-quiet-2', now0);
    seedRelayGroup(rig.world, {
      convId: groupConvId,
      poolNumber,
      participants: [
        { contactId: 'contact-quiet-2', phone: tenantPhone, name: 'Tina Tenant' },
        { contactId: 'contact-quiet-2b', phone: landlordPhone, name: 'Larry Landlord' },
      ],
      now: now0,
    });

    const tour = await tours.create({
      tenantId: 'contact-quiet-2',
      unitId: 'unit-quiet-2',
      scheduledAt: '2026-01-15T20:00:00.000Z',
      tourType: 'landlord_led',
    });
    await tours.patch(tour.tourId, { groupThreadId: groupConvId });
    const legacy = await tourReminders.create({
      tourId: tour.tourId,
      kind: 'confirmation',
      dueAt: '2026-01-15T08:00:00.000Z',
    });

    const inWindow = '2026-01-15T09:00:00.000Z';
    await runDueTourReminders(inWindow, deps);

    // No member text at 4am, and the rung is untouched.
    expect(rig.groupSends).toHaveLength(0);
    expect(rig.world.sent).toHaveLength(0);
    const deferred = (await tourReminders.listByTour(tour.tourId)).find(
      (r) => r.reminderId === legacy.reminderId,
    );
    expect(deferred?.sentAt).toBeUndefined();
    expect(deferred?.skippedAt).toBeUndefined();

    // After quiet-end the whole group is texted from the pool number.
    await runDueTourReminders('2026-01-15T13:05:00.000Z', deps);
    expect(rig.groupSends).toHaveLength(2);
    expect(rig.groupSends.map((s) => s.to).sort()).toEqual([tenantPhone, landlordPhone].sort());
  });

  // ---------------------------------------------------------------------------
  // Test 2f - RELEASE SUPERSESSION: legacy rungs released together at quiet-end
  // must not double-fire; the earlier rung retires unsent
  // ---------------------------------------------------------------------------
  it('release supersession: an earlier rung due beside a LATER rung of the SAME tour is claim-skipped quiet_hours_superseded', async () => {
    const rig = createGroupTestRig();
    const deps = quietOnDeps(rig.deps);
    const tenantPhone = '+15550210003';
    seedTenant(rig.world, 'contact-quiet-3', tenantPhone, 'conv-quiet-3', '2026-01-14T15:00:00.000Z');

    const tour = await tours.create({
      tenantId: 'contact-quiet-3',
      unitId: 'unit-quiet-3',
      scheduledAt: '2026-01-16T20:00:00.000Z',
      tourType: 'self_guided',
    });
    // Both sat inside the window and are released by the SAME tick.
    const dayBefore = await tourReminders.create({
      tourId: tour.tourId,
      kind: 'day_before',
      dueAt: '2026-01-15T08:00:00.000Z',
    });
    const morningOf = await tourReminders.create({
      tourId: tour.tourId,
      kind: 'morning_of',
      dueAt: '2026-01-15T12:00:00.000Z',
    });

    const afterWindow = '2026-01-15T13:05:00.000Z';
    await runDueTourReminders(afterWindow, deps);

    const rows = await tourReminders.listByTour(tour.tourId);
    const earlier = rows.find((r) => r.reminderId === dayBefore.reminderId);
    const later = rows.find((r) => r.reminderId === morningOf.reminderId);
    // The stale rung is RETIRED (skip stamp, never a sent stamp).
    expect(earlier?.sentAt).toBeUndefined();
    expect(earlier?.skippedAt).toBe(afterWindow);
    expect(earlier?.skipReason).toBe('quiet_hours_superseded');
    // The current rung sends.
    expect(later?.sentAt).toBe(afterWindow);
    // EXACTLY one text about this tour.
    expect(rig.world.sent).toHaveLength(1);
    expect(rig.world.sent[0]!.body).toBe(rungBody('morning_of', '2026-01-16T20:00:00.000Z'));
  });

  // ---------------------------------------------------------------------------
  // Test 2f-off - release supersession is DELIBERATELY unconditional: it applies
  // with quiet hours switched OFF too. Its job is "never text stale copy on a
  // catch-up tick", and worker downtime stacks same-tour rungs regardless of the
  // window. Pinned here so nobody "fixes" it into a quiet-hours-only rule.
  // ---------------------------------------------------------------------------
  it('release supersession applies with quiet hours DISABLED too (catch-up staleness, not a window rule)', async () => {
    const rig = createGroupTestRig();
    const deps = { ...rig.deps, settingsRepo: quietOffSettingsRepo() };
    const tenantPhone = '+15550210009';
    seedTenant(rig.world, 'contact-quiet-off-1', tenantPhone, 'conv-quiet-off-1', '2026-01-14T15:00:00.000Z');

    const tour = await tours.create({
      tenantId: 'contact-quiet-off-1',
      unitId: 'unit-quiet-off-1',
      scheduledAt: '2026-01-15T20:00:00.000Z',
      tourType: 'self_guided',
    });
    // Midday dueAts (nowhere near 21:00-08:00) that a stalled worker lists in ONE
    // catch-up batch.
    const morningOf = await tourReminders.create({
      tourId: tour.tourId,
      kind: 'morning_of',
      dueAt: '2026-01-15T16:00:00.000Z',
    });
    const enRoute = await tourReminders.create({
      tourId: tour.tourId,
      kind: 'en_route',
      dueAt: '2026-01-15T16:05:00.000Z',
    });

    const catchUp = '2026-01-15T16:06:00.000Z';
    await runDueTourReminders(catchUp, deps);

    const rows = await tourReminders.listByTour(tour.tourId);
    const earlier = rows.find((r) => r.reminderId === morningOf.reminderId);
    const later = rows.find((r) => r.reminderId === enRoute.reminderId);
    expect(earlier?.sentAt).toBeUndefined();
    expect(earlier?.skippedAt).toBe(catchUp);
    // The token is NOT renamed for the off case: the panel reads it as
    // "superseded by a later reminder", which is accurate either way.
    expect(earlier?.skipReason).toBe('quiet_hours_superseded');
    expect(later?.sentAt).toBe(catchUp);
    expect(rig.world.sent).toHaveLength(1);
    expect(rig.world.sent[0]!.body).toBe(rungBody('en_route', '2026-01-15T20:00:00.000Z'));
  });

  // ---------------------------------------------------------------------------
  // Test 2g - supersession is per-TOUR: two tenants' rungs never cancel each other
  // ---------------------------------------------------------------------------
  it('rungs of DIFFERENT tours never supersede each other (both send)', async () => {
    const rig = createGroupTestRig();
    const deps = quietOnDeps(rig.deps);
    const phoneA = '+15550210004';
    const phoneB = '+15550210005';
    seedTenant(rig.world, 'contact-quiet-4a', phoneA, 'conv-quiet-4a', '2026-01-14T15:00:00.000Z');
    seedTenant(rig.world, 'contact-quiet-4b', phoneB, 'conv-quiet-4b', '2026-01-14T15:00:00.000Z');

    const tourA = await tours.create({
      tenantId: 'contact-quiet-4a',
      unitId: 'unit-quiet-4a',
      scheduledAt: '2026-01-16T20:00:00.000Z',
      tourType: 'self_guided',
    });
    const tourB = await tours.create({
      tenantId: 'contact-quiet-4b',
      unitId: 'unit-quiet-4b',
      scheduledAt: '2026-01-15T20:00:00.000Z',
      tourType: 'self_guided',
    });
    // A's EARLIER rung + B's LATER rung, both released by the same tick.
    const rowA = await tourReminders.create({
      tourId: tourA.tourId,
      kind: 'day_before',
      dueAt: '2026-01-15T08:00:00.000Z',
    });
    const rowB = await tourReminders.create({
      tourId: tourB.tourId,
      kind: 'morning_of',
      dueAt: '2026-01-15T12:00:00.000Z',
    });

    const afterWindow = '2026-01-15T13:05:00.000Z';
    await runDueTourReminders(afterWindow, deps);

    const a = (await tourReminders.listByTour(tourA.tourId)).find((r) => r.reminderId === rowA.reminderId);
    const b = (await tourReminders.listByTour(tourB.tourId)).find((r) => r.reminderId === rowB.reminderId);
    expect(a?.sentAt).toBe(afterWindow);
    expect(a?.skipReason).toBeUndefined();
    expect(b?.sentAt).toBe(afterWindow);
    expect(b?.skipReason).toBeUndefined();
    expect(rig.world.sent).toHaveLength(2);
    // A's day_before is composed from A's tour time, B's morning_of from B's -
    // the two rungs no longer share a body once the copy carries the instant.
    expect(rig.world.sent.map((s) => s.body).sort()).toEqual(
      [
        rungBody('day_before', '2026-01-16T20:00:00.000Z'),
        rungBody('morning_of', '2026-01-15T20:00:00.000Z'),
      ].sort(),
    );
  });

  // ---------------------------------------------------------------------------
  // Test 3 — reschedule: cancel old reminders, re-arm with new scheduledAt
  // ---------------------------------------------------------------------------
  it('cancel + re-arm on reschedule produces new rows with updated dueAts', async () => {
    const now0 = '2026-07-13T11:00:00.000Z';
    // Both tours sit at 15:00 / 14:00 EDT (they used to be 07:00 / 10:00 EDT):
    // an early-morning tour drops rungs for reasons this case is not about -
    // morning_of lands after a 07:00 start (past-event), and a 10:00 start puts
    // en_route exactly on the 08:00-local morning_of slot (supersession).
    const origScheduledAt = '2026-07-15T19:00:00.000Z';
    const newScheduledAt = '2026-07-20T18:00:00.000Z'; // rescheduled to T+7d

    const tour = await tours.create({
      tenantId: 'contact-reschedule-1',
      unitId: 'unit-reschedule-1',
      scheduledAt: origScheduledAt,
      tourType: 'self_guided',
    });

    // Arm original reminders.
    await armTourReminders(tour, now0, {
      tourRemindersRepo: tourReminders,
      settingsRepo: quietOff,
      logger,
    });
    const origRows = await tourReminders.listByTour(tour.tourId);
    expect(origRows).toHaveLength(4);

    // Cancel and re-arm with the new scheduledAt.
    await cancelTourReminders(tour.tourId, { tourRemindersRepo: tourReminders, logger });

    // All original rows should be canceled.
    const afterCancel = await tourReminders.listByTour(tour.tourId);
    expect(afterCancel.every((r) => r.canceledAt !== undefined)).toBe(true);

    // Patch the tour with the new scheduledAt.
    const patchedTour = await tours.patch(tour.tourId, { scheduledAt: newScheduledAt });
    await armTourReminders(patchedTour, now0, {
      tourRemindersRepo: tourReminders,
      settingsRepo: quietOff,
      logger,
    });

    // New rows should exist in addition to the canceled ones.
    const allRows = await tourReminders.listByTour(tour.tourId);
    const newRows = allRows.filter((r) => r.canceledAt === undefined);
    expect(newRows).toHaveLength(4);

    // New day_before should reflect the new scheduledAt: newScheduledAt - 24h.
    const dayBefore = newRows.find((r) => r.kind === 'day_before');
    expect(dayBefore?.dueAt).toBe('2026-07-19T18:00:00.000Z');

    // no_show_checkin is manual-send only now, so re-arm does NOT create it.
    const noShow = newRows.find((r) => r.kind === 'no_show_checkin');
    expect(noShow).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // Test 4 — cancel tour: all pending rows marked canceled
  // ---------------------------------------------------------------------------
  it('cancelTourReminders marks all pending rows canceled', async () => {
    const now0 = '2026-07-13T12:00:00.000Z';
    const scheduledAt = '2026-07-16T10:00:00.000Z';

    const tour = await tours.create({
      tenantId: 'contact-cancel-1',
      unitId: 'unit-cancel-1',
      scheduledAt,
      tourType: 'landlord_led',
    });

    await armTourReminders(tour, now0, {
      tourRemindersRepo: tourReminders,
      settingsRepo: quietOff,
      logger,
    });

    // Manually mark the confirmation row as sent (simulates one already fired).
    const rows = await tourReminders.listByTour(tour.tourId);
    const confirmRow = rows.find((r) => r.kind === 'confirmation');
    await tourReminders.claimSend(confirmRow!.reminderId, now0);

    // Now cancel.
    await cancelTourReminders(tour.tourId, { tourRemindersRepo: tourReminders, logger });

    const afterCancel = await tourReminders.listByTour(tour.tourId);
    // Pending = the same definition cancelForTour uses: no terminal stamp at
    // all. (This 06:00 EDT tour births morning_of as a past_event skipped row -
    // a visible trace, not a pending rung, so cancel rightly leaves it alone.)
    const stillPending = afterCancel.filter(
      (r) => r.sentAt === undefined && r.canceledAt === undefined && r.skippedAt === undefined,
    );
    expect(stillPending).toHaveLength(0);

    // The already-sent row should still be sent (not double-canceled).
    const confirmAfter = afterCancel.find((r) => r.kind === 'confirmation');
    expect(confirmAfter?.sentAt).toBeDefined();
    // canceledAt should NOT be set on the sent row (the condition guard).
    // Note: the cancelForTour implementation only cancels rows with no sentAt AND no canceledAt.
    // The sent row has sentAt set, so it should be excluded from cancelation.
    // (If the conditional update races, it should fail silently — but in our test it's deterministic.)
    // The sent row may or may not have canceledAt — depends on timing. But we verified stillPending=0.
  });

  // ---------------------------------------------------------------------------
  // Test 5 — same-day tour: day_before is in the past and skipped
  // ---------------------------------------------------------------------------
  it('armTourReminders skips day_before when it is in the past (same-day tour)', async () => {
    // Tour is scheduled for the same day — day_before (scheduledAt - 24h) is in the past.
    const now0 = '2026-07-13T09:00:00.000Z';
    const scheduledAt = '2026-07-13T14:00:00.000Z'; // only 5 hours from now

    const tour = await tours.create({
      tenantId: 'contact-sameday-1',
      unitId: 'unit-sameday-1',
      scheduledAt,
      tourType: 'pm_team',
    });

    const rows = await armTourReminders(tour, now0, {
      tourRemindersRepo: tourReminders,
      settingsRepo: quietOff,
      logger,
    });

    const armedKinds = rows.filter((r) => r.skippedAt === undefined).map((r) => r.kind);

    // day_before = scheduledAt - 24h = '2026-07-12T14:00:00.000Z' < now0 → past-dueAt,
    // the pre-existing SILENT skip (no row at all).
    expect(rows.map((r) => r.kind)).not.toContain('day_before');

    // confirmation = now0 - always armed (quiet hours are OFF for this case)
    expect(armedKinds).toContain('confirmation');

    // morning_of = 08:00 ORG-LOCAL on 2026-07-13 (EDT) = '2026-07-13T12:00:00.000Z',
    // which is the SAME instant as en_route below -> the later rung wins and
    // morning_of is retired as a VISIBLE skipped row (the panel's honest trace).
    const morningOf = rows.find((r) => r.kind === 'morning_of');
    expect(morningOf?.skippedAt).toBe(now0);
    expect(morningOf?.skipReason).toBe('quiet_hours_superseded');
    expect(armedKinds).not.toContain('morning_of');

    // en_route = scheduledAt - 2h = '2026-07-13T12:00:00.000Z' > now0 → armed
    expect(armedKinds).toContain('en_route');

    // no_show_checkin is manual-send only now, so it is never auto-armed.
    expect(rows.map((r) => r.kind)).not.toContain('no_show_checkin');
  });

  // ---------------------------------------------------------------------------
  // Test 6 — listDue returns only pending rows with dueAt <= now
  // ---------------------------------------------------------------------------
  it('listDue excludes sentAt and canceledAt rows', async () => {
    const now0 = '2026-07-13T15:00:00.000Z';
    const scheduledAt = '2026-07-15T15:00:00.000Z';

    const tour = await tours.create({
      tenantId: 'contact-listdue-1',
      unitId: 'unit-listdue-1',
      scheduledAt,
      tourType: 'self_guided',
    });

    await armTourReminders(tour, now0, {
      tourRemindersRepo: tourReminders,
      settingsRepo: quietOff,
      logger,
    });

    // Only the confirmation row has dueAt=now0 <= now0.
    const dueRows1 = await tourReminders.listDue(now0);
    const forThisTour1 = dueRows1.filter((r) => r.tourId === tour.tourId);
    expect(forThisTour1).toHaveLength(1);
    expect(forThisTour1[0]!.kind).toBe('confirmation');

    // Mark the confirmation row as sent via claimSend (the production API).
    await tourReminders.claimSend(forThisTour1[0]!.reminderId, now0);

    // Second listDue at the same time — no more due rows for this tour.
    const dueRows2 = await tourReminders.listDue(now0);
    const forThisTour2 = dueRows2.filter((r) => r.tourId === tour.tourId);
    expect(forThisTour2).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // Test 7 — [concurrency] two racing runDueTourReminders → exactly ONE send
  // (RED until claim-before-send fix lands)
  // ---------------------------------------------------------------------------
  it('two concurrent runDueTourReminders calls over the same due row send exactly once', async () => {
    // Fresh world so send counts are isolated.
    const racingWorld = createFakeWorld();
    const racingSend = createSendMessageService({
      logger,
      adapter: racingWorld.adapter,
      conversationsRepo: racingWorld.conversationsRepo,
      messagesRepo: racingWorld.messagesRepo,
      contactsRepo: racingWorld.contactsRepo,
      auditRepo: racingWorld.auditRepo,
      events: racingWorld.events,
    });

    const phone = '+15550300001';
    const contactId = 'contact-race-1';
    const convId = 'conv-race-1';
    const now0 = '2026-07-13T16:00:00.000Z';
    const scheduledAt = '2026-07-15T16:00:00.000Z';

    racingWorld.contacts.push({
      contactId,
      type: 'tenant',
      phone,
      created_at: now0,
    } as Parameters<typeof racingWorld.contacts.push>[0]);
    racingWorld.conversations.set(convId, {
      conversationId: convId,
      participant_phone: phone,
      status: 'open',
      type: 'tenant_1to1',
      ai_mode: 'auto',
      last_activity_at: now0,
      created_at: now0,
    });

    const tour = await tours.create({
      tenantId: contactId,
      unitId: 'unit-race-1',
      scheduledAt,
      tourType: 'self_guided',
    });

    // Arm the confirmation row only (now0 as arm time).
    await armTourReminders(tour, now0, {
      tourRemindersRepo: tourReminders,
      settingsRepo: quietOff,
      logger,
    });

    const racingDeps = {
      tourRemindersRepo: tourReminders,
      toursRepo: tours,
      contactsRepo: racingWorld.contactsRepo,
      conversationsRepo: racingWorld.conversationsRepo,
      messagesRepo: racingWorld.messagesRepo,
      unitsRepo: racingWorld.unitsRepo,
      sendMessageService: racingSend,
      adapter: createAdapterSpy().adapter,
      settingsRepo: quietOff,
      logger,
    };

    // Run two polls concurrently — they both see the same due row.
    await Promise.all([
      runDueTourReminders(now0, racingDeps),
      runDueTourReminders(now0, racingDeps),
    ]);

    // Claim-before-send: exactly ONE send must have happened.
    expect(racingWorld.sent).toHaveLength(1);
  });

  // ---------------------------------------------------------------------------
  // Test 8 — [concurrency] row canceled after listDue but before claim → 0 sends
  // (RED until claim-before-send fix lands; the claim condition includes canceledAt)
  // ---------------------------------------------------------------------------
  it('a row canceled between listDue and the claim step fires zero sends', async () => {
    const cancelWorld = createFakeWorld();
    const cancelSend = createSendMessageService({
      logger,
      adapter: cancelWorld.adapter,
      conversationsRepo: cancelWorld.conversationsRepo,
      messagesRepo: cancelWorld.messagesRepo,
      contactsRepo: cancelWorld.contactsRepo,
      auditRepo: cancelWorld.auditRepo,
      events: cancelWorld.events,
    });

    const phone = '+15550400001';
    const contactId = 'contact-cancel-race-1';
    const convId = 'conv-cancel-race-1';
    const now0 = '2026-07-13T17:00:00.000Z';
    const scheduledAt = '2026-07-15T17:00:00.000Z';

    cancelWorld.contacts.push({
      contactId,
      type: 'tenant',
      phone,
      created_at: now0,
    } as Parameters<typeof cancelWorld.contacts.push>[0]);
    cancelWorld.conversations.set(convId, {
      conversationId: convId,
      participant_phone: phone,
      status: 'open',
      type: 'tenant_1to1',
      ai_mode: 'auto',
      last_activity_at: now0,
      created_at: now0,
    });

    const tour = await tours.create({
      tenantId: contactId,
      unitId: 'unit-cancel-race-1',
      scheduledAt,
      tourType: 'self_guided',
    });

    await armTourReminders(tour, now0, {
      tourRemindersRepo: tourReminders,
      settingsRepo: quietOff,
      logger,
    });

    // List due rows (simulating what runDueTourReminders does internally) —
    // then cancel the tour BEFORE the claim fires.
    const dueRows = await tourReminders.listDue(now0);
    const confirmRow = dueRows.find((r) => r.tourId === tour.tourId && r.kind === 'confirmation');
    expect(confirmRow).toBeDefined();

    // Cancel the tour's reminders (simulates PATCH /tours/:id { status: 'canceled' }).
    await cancelTourReminders(tour.tourId, { tourRemindersRepo: tourReminders, logger });

    // Now attempt to run — the claim should fail for the canceled row → zero sends.
    const cancelDeps = {
      tourRemindersRepo: tourReminders,
      toursRepo: tours,
      contactsRepo: cancelWorld.contactsRepo,
      conversationsRepo: cancelWorld.conversationsRepo,
      messagesRepo: cancelWorld.messagesRepo,
      unitsRepo: cancelWorld.unitsRepo,
      sendMessageService: cancelSend,
      adapter: createAdapterSpy().adapter,
      settingsRepo: quietOff,
      logger,
    };
    await runDueTourReminders(now0, cancelDeps);

    expect(cancelWorld.sent).toHaveLength(0);
  });

  // ===========================================================================
  // Group-thread reminder routing (Task 2 — founder decision 2026-07-02):
  // landlord_led / pm_team reminders go to the tour's masked GROUP thread via
  // DIRECT per-member adapter sends FROM the pool number (the relay.intro
  // precedent — sendMessageService refuses relay_group threads and the worker
  // cannot enqueue jobs); self_guided stays tenant-1:1 even when a group
  // exists; any unusable group (no groupThreadId / missing conversation /
  // wrong type / closed) falls back to the tenant-1:1 path — a reminder must
  // never be lost.
  //
  // These tests use their OWN August timeline (the earlier tests live on
  // 2026-07-13..15) so leftover pending rows from other tests are never due
  // at these polls, and fresh per-test worlds so send counts are isolated.
  // ===========================================================================

  // No shared CONFIRMATION_BODY constant: the copy now carries the tour's own
  // time, so each case composes from ITS fixture's scheduledAt via rungBody().

  /** Adapter spy for the GROUP route: records direct sends; never a network. */
  function createAdapterSpy(opts: { failFor?: string[] } = {}): {
    adapter: MessagingAdapter;
    sends: SendMessageParams[];
  } {
    const sends: SendMessageParams[] = [];
    let sidCounter = 0;
    const adapter: MessagingAdapter = {
      async sendMessage(params) {
        if (opts.failFor?.includes(params.to)) {
          throw new Error('adapter spy: injected send failure');
        }
        sends.push(params);
        sidCounter += 1;
        return {
          providerSid: `SMspy-${sidCounter}`,
          status: 'queued',
          providerTs: new Date().toISOString(),
        };
      },
      async getMediaStream() {
        throw new Error('adapter spy: getMediaStream not expected');
      },
      async getRecordingStream() {
        throw new Error('adapter spy: getRecordingStream not expected');
      },
      async provisionPhoneNumber() {
        throw new Error('adapter spy: provisionPhoneNumber not expected');
      },
      async setVoiceWebhook() {
        throw new Error('adapter spy: setVoiceWebhook not expected');
      },
      async releasePhoneNumber() {
        throw new Error('adapter spy: releasePhoneNumber not expected');
      },
      async attachToMessagingService() {
        throw new Error('adapter spy: attachToMessagingService not expected');
      },
      async detachFromMessagingService() {
        throw new Error('adapter spy: detachFromMessagingService not expected');
      },
      async initiateCall() {
        throw new Error('adapter spy: initiateCall not expected');
      },
      async createViTranscript() {
        throw new Error('adapter spy: createViTranscript not expected');
      },
      async fetchViTranscript() {
        throw new Error('adapter spy: fetchViTranscript not expected');
      },
      async listViSentences() {
        throw new Error('adapter spy: listViSentences not expected');
      },
    };
    return { adapter, sends };
  }

  /**
   * Fresh world + full runDueTourReminders deps with a group-adapter spy.
   * The 1:1 path sends via the world's own adapter (world.sent); the group
   * path sends via the spy (groupSends) — so the two routes are separable.
   */
  function createGroupTestRig(opts: { failFor?: string[] } = {}) {
    const world = createFakeWorld();
    const spy = createAdapterSpy(opts);
    const send = createSendMessageService({
      logger,
      adapter: world.adapter,
      conversationsRepo: world.conversationsRepo,
      messagesRepo: world.messagesRepo,
      contactsRepo: world.contactsRepo,
      auditRepo: world.auditRepo,
      events: world.events,
    });
    const deps = {
      tourRemindersRepo: tourReminders,
      toursRepo: tours,
      contactsRepo: world.contactsRepo,
      conversationsRepo: world.conversationsRepo,
      // Group rungs persist a system announcement row in the relay thread
      // (sendRelayAnnouncement) — the world's message store backs it.
      messagesRepo: world.messagesRepo,
      unitsRepo: world.unitsRepo,
      sendMessageService: send,
      adapter: spy.adapter,
      settingsRepo: quietOff,
      logger,
    };
    return { world, deps, groupSends: spy.sends };
  }

  function seedTenant(
    world: ReturnType<typeof createFakeWorld>,
    contactId: string,
    phone: string,
    convId: string,
    now: string,
  ): void {
    world.contacts.push({
      contactId,
      type: 'tenant',
      phone,
      created_at: now,
    } as Parameters<typeof world.contacts.push>[0]);
    world.conversations.set(convId, {
      conversationId: convId,
      participant_phone: phone,
      status: 'open',
      type: 'tenant_1to1',
      ai_mode: 'auto',
      last_activity_at: now,
      created_at: now,
    });
  }

  function seedRelayGroup(
    world: ReturnType<typeof createFakeWorld>,
    opts: {
      convId: string;
      poolNumber: string;
      status?: 'open' | 'closed';
      participants: ConversationParticipant[];
      now: string;
    },
  ): void {
    world.conversations.set(opts.convId, {
      conversationId: opts.convId,
      // relay_group threads carry the pool number as the synthetic placeholder.
      participant_phone: opts.poolNumber,
      status: opts.status ?? 'open',
      type: 'relay_group',
      ai_mode: 'manual',
      last_activity_at: opts.now,
      created_at: opts.now,
      pool_number: opts.poolNumber,
      participants: opts.participants,
    });
  }

  // ---------------------------------------------------------------------------
  // Test 9 — landlord_led + open group: every member texted FROM the pool number
  // ---------------------------------------------------------------------------
  it('landlord_led tour with an open group: reminder goes to EVERY member from the pool number, not the 1:1', async () => {
    const rig = createGroupTestRig();
    const now0 = '2026-08-01T10:00:00.000Z';
    const scheduledAt = '2026-08-03T18:00:00.000Z';
    const tenantPhone = '+15550500001';
    const landlordPhone = '+15550500002';
    const poolNumber = '+15550190001';
    const groupConvId = 'conv-group-ll-1';

    seedTenant(rig.world, 'contact-group-ll-1', tenantPhone, 'conv-1to1-ll-1', now0);
    seedRelayGroup(rig.world, {
      convId: groupConvId,
      poolNumber,
      participants: [
        { contactId: 'contact-group-ll-1', phone: tenantPhone, name: 'Tina Tenant' },
        { contactId: 'contact-group-ll-2', phone: landlordPhone, name: 'Larry Landlord' },
      ],
      now: now0,
    });

    const tour = await tours.create({
      tenantId: 'contact-group-ll-1',
      unitId: 'unit-group-ll-1',
      scheduledAt,
      tourType: 'landlord_led',
    });
    await tours.patch(tour.tourId, { groupThreadId: groupConvId });
    await armTourReminders(tour, now0, {
      tourRemindersRepo: tourReminders,
      settingsRepo: quietOff,
      logger,
    });

    // Only the confirmation rung is due at now0.
    await runDueTourReminders(now0, rig.deps);

    // Group route: one direct adapter send PER member, FROM the pool number,
    // carrying the same rung body.
    expect(rig.groupSends).toHaveLength(2);
    expect(rig.groupSends.map((s) => s.to).sort()).toEqual([tenantPhone, landlordPhone].sort());
    for (const s of rig.groupSends) {
      expect(s.from).toBe(poolNumber);
      expect(s.body).toBe(rungBody('confirmation', scheduledAt));
    }

    // Founder decision 2026-07-14: the rung is VISIBLE in the group thread —
    // persisted ONCE as a system announcement with per-member delivery slots.
    const announcementRows = rig.world.messages.filter(
      (m) => m.conversationId === groupConvId,
    );
    expect(announcementRows).toHaveLength(1);
    const announcement = announcementRows[0]!;
    expect(announcement.direction).toBe('outbound');
    expect(announcement.author).toBe('system');
    expect(announcement.relay_sender_key).toBe('system');
    expect(announcement.body).toBe(rungBody('confirmation', scheduledAt));
    expect(Object.keys(announcement.delivery_recipients ?? {})).toHaveLength(2);
    // Nothing through the 1:1 send service.
    expect(rig.world.sent).toHaveLength(0);

    // Claim stamped — a second tick sends nothing more (exactly once per member).
    const rows = await tourReminders.listByTour(tour.tourId);
    expect(rows.find((r) => r.kind === 'confirmation')?.sentAt).toBeDefined();
    await runDueTourReminders(now0, rig.deps);
    expect(rig.groupSends).toHaveLength(2);
  });

  it('group sends draw one token per member from the shared A2P bucket when provided', async () => {
    const rig = createGroupTestRig();
    const now0 = '2026-08-01T10:00:00.000Z';
    const scheduledAt = '2026-08-03T18:00:00.000Z';
    seedTenant(rig.world, 'contact-bucket-1', '+15550500011', 'conv-1to1-bucket-1', now0);
    seedRelayGroup(rig.world, {
      convId: 'conv-group-bucket-1',
      poolNumber: '+15550190009',
      participants: [
        { contactId: 'contact-bucket-1', phone: '+15550500011', name: 'Tina Tenant' },
        { contactId: 'contact-bucket-2', phone: '+15550500012', name: 'Larry Landlord' },
      ],
      now: now0,
    });
    const tour = await tours.create({
      tenantId: 'contact-bucket-1',
      unitId: 'unit-bucket-1',
      scheduledAt,
      tourType: 'landlord_led',
    });
    await tours.patch(tour.tourId, { groupThreadId: 'conv-group-bucket-1' });
    await armTourReminders(tour, now0, {
      tourRemindersRepo: tourReminders,
      settingsRepo: quietOff,
      logger,
    });

    // Counting bucket: every adapter send must be preceded by one acquire(1) —
    // the same combined A2P rate metering the relay fan-out/intro loops use.
    let acquired = 0;
    const bucket = {
      acquire: async (n: number) => {
        acquired += n;
      },
    };
    await runDueTourReminders(now0, { ...rig.deps, tokenBucket: bucket });

    expect(rig.groupSends).toHaveLength(2);
    expect(acquired).toBe(2);
  });

  // ---------------------------------------------------------------------------
  // Test 10 — pm_team + open group: same group routing
  // ---------------------------------------------------------------------------
  it('pm_team tour with an open group routes reminders to the group', async () => {
    const rig = createGroupTestRig();
    const now0 = '2026-08-01T11:00:00.000Z';
    const scheduledAt = '2026-08-03T19:00:00.000Z';
    const tenantPhone = '+15550510001';
    const pmPhone = '+15550510002';
    const poolNumber = '+15550190002';
    const groupConvId = 'conv-group-pm-1';

    seedTenant(rig.world, 'contact-group-pm-1', tenantPhone, 'conv-1to1-pm-1', now0);
    seedRelayGroup(rig.world, {
      convId: groupConvId,
      poolNumber,
      participants: [
        { contactId: 'contact-group-pm-1', phone: tenantPhone, name: 'Tina Tenant' },
        { contactId: 'contact-group-pm-2', phone: pmPhone, name: 'Pat PM' },
      ],
      now: now0,
    });

    const tour = await tours.create({
      tenantId: 'contact-group-pm-1',
      unitId: 'unit-group-pm-1',
      scheduledAt,
      tourType: 'pm_team',
    });
    await tours.patch(tour.tourId, { groupThreadId: groupConvId });
    await armTourReminders(tour, now0, {
      tourRemindersRepo: tourReminders,
      settingsRepo: quietOff,
      logger,
    });

    await runDueTourReminders(now0, rig.deps);

    expect(rig.groupSends).toHaveLength(2);
    expect(rig.groupSends.every((s) => s.from === poolNumber)).toBe(true);
    expect(rig.world.sent).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // Test 11 — self_guided stays 1:1 EVEN IF a group thread exists (founder rule)
  // ---------------------------------------------------------------------------
  it('self_guided tour with a group thread set still sends the reminder to the tenant 1:1', async () => {
    const rig = createGroupTestRig();
    const now0 = '2026-08-01T12:00:00.000Z';
    const scheduledAt = '2026-08-03T20:00:00.000Z';
    const tenantPhone = '+15550520001';
    const poolNumber = '+15550190003';
    const groupConvId = 'conv-group-sg-1';

    seedTenant(rig.world, 'contact-group-sg-1', tenantPhone, 'conv-1to1-sg-1', now0);
    seedRelayGroup(rig.world, {
      convId: groupConvId,
      poolNumber,
      participants: [
        { contactId: 'contact-group-sg-1', phone: tenantPhone, name: 'Tina Tenant' },
        { contactId: 'contact-group-sg-2', phone: '+15550520002', name: 'Larry Landlord' },
      ],
      now: now0,
    });

    const tour = await tours.create({
      tenantId: 'contact-group-sg-1',
      unitId: 'unit-group-sg-1',
      scheduledAt,
      tourType: 'self_guided',
    });
    await tours.patch(tour.tourId, { groupThreadId: groupConvId });
    await armTourReminders(tour, now0, {
      tourRemindersRepo: tourReminders,
      settingsRepo: quietOff,
      logger,
    });

    await runDueTourReminders(now0, rig.deps);

    // 1:1 route: sent via sendMessageService (world adapter), NOT the group spy.
    expect(rig.groupSends).toHaveLength(0);
    expect(rig.world.sent).toHaveLength(1);
    expect(rig.world.sent[0]!.to).toBe(tenantPhone);
    expect(rig.world.sent[0]!.body).toContain(rungBody('confirmation', scheduledAt));
  });

  // ---------------------------------------------------------------------------
  // Test 12 — landlord_led with NO groupThreadId: 1:1 fallback
  // ---------------------------------------------------------------------------
  it('landlord_led tour with no groupThreadId falls back to the tenant 1:1', async () => {
    const rig = createGroupTestRig();
    const now0 = '2026-08-01T13:00:00.000Z';
    const scheduledAt = '2026-08-03T21:00:00.000Z';
    const tenantPhone = '+15550530001';

    seedTenant(rig.world, 'contact-nogroup-1', tenantPhone, 'conv-1to1-ng-1', now0);

    const tour = await tours.create({
      tenantId: 'contact-nogroup-1',
      unitId: 'unit-nogroup-1',
      scheduledAt,
      tourType: 'landlord_led',
    });
    await armTourReminders(tour, now0, {
      tourRemindersRepo: tourReminders,
      settingsRepo: quietOff,
      logger,
    });

    await runDueTourReminders(now0, rig.deps);

    expect(rig.groupSends).toHaveLength(0);
    expect(rig.world.sent).toHaveLength(1);
    expect(rig.world.sent[0]!.to).toBe(tenantPhone);
  });

  // ---------------------------------------------------------------------------
  // Test 13 — groupThreadId → missing conversation: 1:1 fallback
  // ---------------------------------------------------------------------------
  it('landlord_led tour whose groupThreadId points at a missing conversation falls back to 1:1', async () => {
    const rig = createGroupTestRig();
    const now0 = '2026-08-01T14:00:00.000Z';
    const scheduledAt = '2026-08-03T22:00:00.000Z';
    const tenantPhone = '+15550540001';

    seedTenant(rig.world, 'contact-missingconv-1', tenantPhone, 'conv-1to1-mc-1', now0);

    const tour = await tours.create({
      tenantId: 'contact-missingconv-1',
      unitId: 'unit-missingconv-1',
      scheduledAt,
      tourType: 'landlord_led',
    });
    await tours.patch(tour.tourId, { groupThreadId: 'conv-does-not-exist' });
    await armTourReminders(tour, now0, {
      tourRemindersRepo: tourReminders,
      settingsRepo: quietOff,
      logger,
    });

    await runDueTourReminders(now0, rig.deps);

    expect(rig.groupSends).toHaveLength(0);
    expect(rig.world.sent).toHaveLength(1);
    expect(rig.world.sent[0]!.to).toBe(tenantPhone);
  });

  // ---------------------------------------------------------------------------
  // Test 14 — groupThreadId → a NON-relay_group conversation: 1:1 fallback
  // ---------------------------------------------------------------------------
  it('landlord_led tour whose groupThreadId points at a non-relay_group conversation falls back to 1:1', async () => {
    const rig = createGroupTestRig();
    const now0 = '2026-08-01T14:30:00.000Z';
    const scheduledAt = '2026-08-03T22:30:00.000Z';
    const tenantPhone = '+15550545001';

    seedTenant(rig.world, 'contact-wrongtype-1', tenantPhone, 'conv-1to1-wt-1', now0);

    const tour = await tours.create({
      tenantId: 'contact-wrongtype-1',
      unitId: 'unit-wrongtype-1',
      scheduledAt,
      tourType: 'landlord_led',
    });
    // Points at the tenant's own 1:1 thread — exists but is NOT a relay_group.
    await tours.patch(tour.tourId, { groupThreadId: 'conv-1to1-wt-1' });
    await armTourReminders(tour, now0, {
      tourRemindersRepo: tourReminders,
      settingsRepo: quietOff,
      logger,
    });

    await runDueTourReminders(now0, rig.deps);

    expect(rig.groupSends).toHaveLength(0);
    expect(rig.world.sent).toHaveLength(1);
    expect(rig.world.sent[0]!.to).toBe(tenantPhone);
  });

  // ---------------------------------------------------------------------------
  // Test 15 — CLOSED group: 1:1 fallback
  // ---------------------------------------------------------------------------
  it('landlord_led tour with a CLOSED group thread falls back to 1:1', async () => {
    const rig = createGroupTestRig();
    const now0 = '2026-08-01T15:00:00.000Z';
    const scheduledAt = '2026-08-03T23:00:00.000Z';
    const tenantPhone = '+15550550001';
    const poolNumber = '+15550190004';
    const groupConvId = 'conv-group-closed-1';

    seedTenant(rig.world, 'contact-closed-1', tenantPhone, 'conv-1to1-cl-1', now0);
    seedRelayGroup(rig.world, {
      convId: groupConvId,
      poolNumber,
      status: 'closed',
      participants: [
        { contactId: 'contact-closed-1', phone: tenantPhone, name: 'Tina Tenant' },
        { contactId: 'contact-closed-2', phone: '+15550550002', name: 'Larry Landlord' },
      ],
      now: now0,
    });

    const tour = await tours.create({
      tenantId: 'contact-closed-1',
      unitId: 'unit-closed-1',
      scheduledAt,
      tourType: 'landlord_led',
    });
    await tours.patch(tour.tourId, { groupThreadId: groupConvId });
    await armTourReminders(tour, now0, {
      tourRemindersRepo: tourReminders,
      settingsRepo: quietOff,
      logger,
    });

    await runDueTourReminders(now0, rig.deps);

    expect(rig.groupSends).toHaveLength(0);
    expect(rig.world.sent).toHaveLength(1);
    expect(rig.world.sent[0]!.to).toBe(tenantPhone);
  });

  // ---------------------------------------------------------------------------
  // Test 16 — suppressed (sms_opt_out) member skipped; others still receive
  // ---------------------------------------------------------------------------
  it('an sms_opt_out group member is skipped while the other members receive the reminder', async () => {
    const rig = createGroupTestRig();
    const now0 = '2026-08-01T16:00:00.000Z';
    const scheduledAt = '2026-08-04T18:00:00.000Z';
    const tenantPhone = '+15550560001';
    const landlordPhone = '+15550560002';
    const poolNumber = '+15550190005';
    const groupConvId = 'conv-group-sup-1';

    seedTenant(rig.world, 'contact-sup-tenant', tenantPhone, 'conv-1to1-sup-1', now0);
    // The landlord member's contact carries sms_opt_out (STOP'd) — suppressed.
    rig.world.contacts.push({
      contactId: 'contact-sup-landlord',
      type: 'landlord',
      phone: landlordPhone,
      sms_opt_out: true,
      created_at: now0,
    } as Parameters<typeof rig.world.contacts.push>[0]);
    seedRelayGroup(rig.world, {
      convId: groupConvId,
      poolNumber,
      participants: [
        { contactId: 'contact-sup-tenant', phone: tenantPhone, name: 'Tina Tenant' },
        { contactId: 'contact-sup-landlord', phone: landlordPhone, name: 'Larry Landlord' },
      ],
      now: now0,
    });

    const tour = await tours.create({
      tenantId: 'contact-sup-tenant',
      unitId: 'unit-sup-1',
      scheduledAt,
      tourType: 'landlord_led',
    });
    await tours.patch(tour.tourId, { groupThreadId: groupConvId });
    await armTourReminders(tour, now0, {
      tourRemindersRepo: tourReminders,
      settingsRepo: quietOff,
      logger,
    });

    await runDueTourReminders(now0, rig.deps);

    // Only the non-suppressed member receives; the STOP'd member is never texted.
    expect(rig.groupSends).toHaveLength(1);
    expect(rig.groupSends[0]!.to).toBe(tenantPhone);
    expect(rig.groupSends[0]!.from).toBe(poolNumber);
    expect(rig.world.sent).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // Test 17 — [concurrency] two racing ticks over a group reminder: once per member
  // ---------------------------------------------------------------------------
  it('two concurrent ticks over the same group reminder send exactly once per member', async () => {
    const rig = createGroupTestRig();
    const now0 = '2026-08-01T17:00:00.000Z';
    const scheduledAt = '2026-08-04T19:00:00.000Z';
    const tenantPhone = '+15550570001';
    const landlordPhone = '+15550570002';
    const poolNumber = '+15550190006';
    const groupConvId = 'conv-group-race-1';

    seedTenant(rig.world, 'contact-grouprace-1', tenantPhone, 'conv-1to1-gr-1', now0);
    seedRelayGroup(rig.world, {
      convId: groupConvId,
      poolNumber,
      participants: [
        { contactId: 'contact-grouprace-1', phone: tenantPhone, name: 'Tina Tenant' },
        { contactId: 'contact-grouprace-2', phone: landlordPhone, name: 'Larry Landlord' },
      ],
      now: now0,
    });

    const tour = await tours.create({
      tenantId: 'contact-grouprace-1',
      unitId: 'unit-grouprace-1',
      scheduledAt,
      tourType: 'landlord_led',
    });
    await tours.patch(tour.tourId, { groupThreadId: groupConvId });
    await armTourReminders(tour, now0, {
      tourRemindersRepo: tourReminders,
      settingsRepo: quietOff,
      logger,
    });

    await Promise.all([
      runDueTourReminders(now0, rig.deps),
      runDueTourReminders(now0, rig.deps),
    ]);

    // Claim-before-send: each member texted exactly ONCE despite two ticks.
    expect(rig.groupSends).toHaveLength(2);
    expect(rig.groupSends.map((s) => s.to).sort()).toEqual([tenantPhone, landlordPhone].sort());
  });

  // ---------------------------------------------------------------------------
  // Test 18 — per-member send failure: other members still receive; claim stays stamped
  // ---------------------------------------------------------------------------
  it('a per-member adapter failure does not block other members and the claim stays stamped', async () => {
    const now0 = '2026-08-01T18:00:00.000Z';
    const scheduledAt = '2026-08-04T20:00:00.000Z';
    const tenantPhone = '+15550580001';
    const landlordPhone = '+15550580002';
    const poolNumber = '+15550190007';
    const groupConvId = 'conv-group-fail-1';

    // The FIRST member's send blows up; the second must still receive.
    const rig = createGroupTestRig({ failFor: [tenantPhone] });

    seedTenant(rig.world, 'contact-groupfail-1', tenantPhone, 'conv-1to1-gf-1', now0);
    seedRelayGroup(rig.world, {
      convId: groupConvId,
      poolNumber,
      participants: [
        { contactId: 'contact-groupfail-1', phone: tenantPhone, name: 'Tina Tenant' },
        { contactId: 'contact-groupfail-2', phone: landlordPhone, name: 'Larry Landlord' },
      ],
      now: now0,
    });

    const tour = await tours.create({
      tenantId: 'contact-groupfail-1',
      unitId: 'unit-groupfail-1',
      scheduledAt,
      tourType: 'landlord_led',
    });
    await tours.patch(tour.tourId, { groupThreadId: groupConvId });
    await armTourReminders(tour, now0, {
      tourRemindersRepo: tourReminders,
      settingsRepo: quietOff,
      logger,
    });

    await runDueTourReminders(now0, rig.deps);

    // The surviving member got the reminder.
    expect(rig.groupSends).toHaveLength(1);
    expect(rig.groupSends[0]!.to).toBe(landlordPhone);
    // The claim is stamped (accepted tradeoff — same post-claim semantics as
    // the 1:1 path): a second tick does NOT retry the failed member.
    const rows = await tourReminders.listByTour(tour.tourId);
    expect(rows.find((r) => r.kind === 'confirmation')?.sentAt).toBeDefined();
    await runDueTourReminders(now0, rig.deps);
    expect(rig.groupSends).toHaveLength(1);
    // Never through the 1:1 service either.
    expect(rig.world.sent).toHaveLength(0);
  });

  // ===========================================================================
  // SEND NOW - forceSendReminder (quiet-hours spec section 7)
  //
  // Human-triggered, so it BYPASSES quiet hours, manual mode and the
  // per-conversation breaker (the 1:1 send goes out with automated: false) but
  // still RESPECTS the absolute gates - kill switch, opt-out, JIT consent - and
  // every gate runs BEFORE the claim, so a refusal never leaves a row
  // claimed-but-unsent. Own February timeline + a fresh world per case.
  // ===========================================================================

  /** Records every sendMessageService input (the real service hides `automated`). */
  function makeForceSendSpy(opts: { throwErr?: Error } = {}): {
    service: SendMessageService;
    sent: SendMessageInput[];
  } {
    const sent: SendMessageInput[] = [];
    const service: SendMessageService = async (input) => {
      sent.push(input);
      if (opts.throwErr) throw opts.throwErr;
      return {
        conversationId: input.conversationId,
        providerSid: 'SM-force-fake',
        tsMsgId: 'ts-force-fake',
        status: 'queued',
      } as SendMessageOutcome;
    };
    return { service, sent };
  }

  /**
   * A tenant whose contact carries RECORDED CONSENT (consent_method). The force
   * path sends with automated: false, which IS subject to the JIT consent gate -
   * so a consent-less contact refuses. seedTenant above deliberately records no
   * consent (the poller's automated sends were never gated on it).
   */
  function seedForceTenant(
    world: ReturnType<typeof createFakeWorld>,
    opts: {
      contactId: string;
      phone: string;
      convId?: string;
      now: string;
      consent?: boolean;
      contactOptOut?: boolean;
      convOptOut?: boolean;
      /** Soft-delete stamp (contactsRepo isDeleted reads a non-empty deleted_at). */
      deletedAt?: string;
    },
  ): void {
    world.contacts.push({
      contactId: opts.contactId,
      type: 'tenant',
      phone: opts.phone,
      created_at: opts.now,
      ...(opts.consent !== false && { consent_method: 'inbound_text' }),
      ...(opts.contactOptOut === true && { sms_opt_out: true }),
      ...(opts.deletedAt !== undefined && { deleted_at: opts.deletedAt }),
    } as Parameters<typeof world.contacts.push>[0]);
    if (opts.convId === undefined) return;
    world.conversations.set(opts.convId, {
      conversationId: opts.convId,
      participant_phone: opts.phone,
      status: 'open',
      type: 'tenant_1to1',
      ai_mode: 'auto',
      last_activity_at: opts.now,
      created_at: opts.now,
      ...(opts.convOptOut === true && { sms_opt_out: true }),
    });
  }

  /** A pending self_guided rung on the February timeline. */
  async function seedForceTour(opts: {
    tenantId: string;
    unitId: string;
    kind: 'confirmation' | 'day_before' | 'morning_of' | 'en_route';
    tourType?: 'self_guided' | 'landlord_led' | 'pm_team';
  }) {
    const tour = await tours.create({
      tenantId: opts.tenantId,
      unitId: opts.unitId,
      scheduledAt: '2026-02-11T20:00:00.000Z',
      tourType: opts.tourType ?? 'self_guided',
    });
    const row = await tourReminders.create({
      tourId: tour.tourId,
      kind: opts.kind,
      dueAt: '2026-02-11T13:00:00.000Z',
    });
    return { tour, row };
  }

  /** Deep inside the DEFAULT window: Feb 10 04:00 EST (America/New_York). */
  const FORCE_NOW = '2026-02-10T09:00:00.000Z';
  const SEEDED_AT = '2026-02-09T15:00:00.000Z';

  // ---------------------------------------------------------------------------
  // Send now 1 - the headline case: it goes out NOW, mid-quiet-hours
  // ---------------------------------------------------------------------------
  it('force-sends a pending rung DURING quiet hours with automated: false and stamps sentAt', async () => {
    const rig = createGroupTestRig();
    const spy = makeForceSendSpy();
    const events = createEventBus({ logger });
    const emitted: Array<{ contactId?: string }> = [];
    events.on('scheduled.updated', (p) => emitted.push(p));
    const deps = {
      ...rig.deps,
      sendMessageService: spy.service,
      settingsRepo: stubSettingsRepo(), // quiet hours ON - the force path ignores them
      events,
    };
    seedForceTenant(rig.world, {
      contactId: 'contact-force-1',
      phone: '+15550220001',
      convId: 'conv-force-1',
      now: SEEDED_AT,
    });
    const { tour, row } = await seedForceTour({
      tenantId: 'contact-force-1',
      unitId: 'unit-force-1',
      kind: 'confirmation',
    });

    // Sanity: at this same instant the POLLER defers (backstop) - so a send
    // here can only come from the human path.
    await runDueTourReminders(FORCE_NOW, deps);
    expect(spy.sent).toHaveLength(0);

    const result = await forceSendReminder(row.reminderId, tour.tourId, FORCE_NOW, true, deps);

    expect(result).toEqual({ outcome: 'sent' });
    expect(spy.sent).toHaveLength(1);
    expect(spy.sent[0]!.conversationId).toBe('conv-force-1');
    expect(spy.sent[0]!.body).toBe(rungBody('confirmation', '2026-02-11T20:00:00.000Z'));
    expect(spy.sent[0]!.author).toBe('teammate');
    // automated: false - a human send bypasses manual mode + the breaker.
    expect(spy.sent[0]!.automated).toBe(false);

    const after = (await tourReminders.listByTour(tour.tourId)).find(
      (r) => r.reminderId === row.reminderId,
    );
    expect(after?.sentAt).toBe(FORCE_NOW);
    // The claim told the live surfaces to refetch (advisory tenant contactId).
    expect(emitted.filter((p) => p.contactId === 'contact-force-1')).toHaveLength(1);
  });

  // ---------------------------------------------------------------------------
  // Send now 2 - the row is already terminal: report honestly, send nothing
  // ---------------------------------------------------------------------------
  it('force-send returns not_pending for an already-sent rung and sends nothing', async () => {
    const rig = createGroupTestRig();
    const spy = makeForceSendSpy();
    const deps = { ...rig.deps, sendMessageService: spy.service, settingsRepo: stubSettingsRepo() };
    seedForceTenant(rig.world, {
      contactId: 'contact-force-2',
      phone: '+15550220002',
      convId: 'conv-force-2',
      now: SEEDED_AT,
    });
    const { tour, row } = await seedForceTour({
      tenantId: 'contact-force-2',
      unitId: 'unit-force-2',
      kind: 'day_before',
    });
    await tourReminders.claimSend(row.reminderId, '2026-02-10T08:00:00.000Z');

    const result = await forceSendReminder(row.reminderId, tour.tourId, FORCE_NOW, true, deps);

    expect(result).toEqual({ outcome: 'not_pending' });
    expect(spy.sent).toHaveLength(0);
    expect(rig.world.sent).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // Send now 3 - the poll wins the claim race: exactly one send ever happens
  // ---------------------------------------------------------------------------
  it('force-send returns not_pending when the claim is LOST, and sends nothing', async () => {
    const rig = createGroupTestRig();
    const spy = makeForceSendSpy();
    // The row is pending when we read it, but the poll claims it first.
    const lostClaimRepo = { ...tourReminders, claimSend: async () => false };
    const deps = {
      ...rig.deps,
      tourRemindersRepo: lostClaimRepo,
      sendMessageService: spy.service,
      settingsRepo: stubSettingsRepo(),
    };
    seedForceTenant(rig.world, {
      contactId: 'contact-force-3',
      phone: '+15550220003',
      convId: 'conv-force-3',
      now: SEEDED_AT,
    });
    const { tour, row } = await seedForceTour({
      tenantId: 'contact-force-3',
      unitId: 'unit-force-3',
      kind: 'day_before',
    });

    const result = await forceSendReminder(row.reminderId, tour.tourId, FORCE_NOW, true, deps);

    expect(result).toEqual({ outcome: 'not_pending' });
    expect(spy.sent).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // Send now 4 - kill switch: refuse BEFORE the claim (the row stays pending)
  // ---------------------------------------------------------------------------
  it('force-send refuses sms_sending_disabled WITHOUT claiming (row stays pending)', async () => {
    const rig = createGroupTestRig();
    const spy = makeForceSendSpy();
    const deps = { ...rig.deps, sendMessageService: spy.service, settingsRepo: stubSettingsRepo() };
    seedForceTenant(rig.world, {
      contactId: 'contact-force-4',
      phone: '+15550220004',
      convId: 'conv-force-4',
      now: SEEDED_AT,
    });
    const { tour, row } = await seedForceTour({
      tenantId: 'contact-force-4',
      unitId: 'unit-force-4',
      kind: 'day_before',
    });

    const result = await forceSendReminder(row.reminderId, tour.tourId, FORCE_NOW, false, deps);

    expect(result).toEqual({ outcome: 'refused', reason: 'sms_sending_disabled' });
    expect(spy.sent).toHaveLength(0);
    const after = (await tourReminders.listByTour(tour.tourId)).find(
      (r) => r.reminderId === row.reminderId,
    );
    expect(after?.sentAt).toBeUndefined();
    expect(after?.skippedAt).toBeUndefined();
    expect(after?.canceledAt).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // Send now 5 - opt-out is absolute, even for a human send
  // ---------------------------------------------------------------------------
  it('force-send refuses contact_opted_out WITHOUT claiming', async () => {
    const rig = createGroupTestRig();
    const spy = makeForceSendSpy();
    const deps = { ...rig.deps, sendMessageService: spy.service, settingsRepo: stubSettingsRepo() };
    seedForceTenant(rig.world, {
      contactId: 'contact-force-5',
      phone: '+15550220005',
      convId: 'conv-force-5',
      now: SEEDED_AT,
      contactOptOut: true,
    });
    const { tour, row } = await seedForceTour({
      tenantId: 'contact-force-5',
      unitId: 'unit-force-5',
      kind: 'day_before',
    });

    const result = await forceSendReminder(row.reminderId, tour.tourId, FORCE_NOW, true, deps);

    expect(result).toEqual({ outcome: 'refused', reason: 'contact_opted_out' });
    expect(spy.sent).toHaveLength(0);
    const after = (await tourReminders.listByTour(tour.tourId)).find(
      (r) => r.reminderId === row.reminderId,
    );
    expect(after?.sentAt).toBeUndefined();
    expect(after?.skippedAt).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // Send now 6 - JIT consent: automated: false makes the consent gate apply
  // ---------------------------------------------------------------------------
  it('force-send refuses no_consent WITHOUT claiming', async () => {
    const rig = createGroupTestRig();
    const spy = makeForceSendSpy();
    const deps = { ...rig.deps, sendMessageService: spy.service, settingsRepo: stubSettingsRepo() };
    seedForceTenant(rig.world, {
      contactId: 'contact-force-6',
      phone: '+15550220006',
      convId: 'conv-force-6',
      now: SEEDED_AT,
      consent: false,
    });
    const { tour, row } = await seedForceTour({
      tenantId: 'contact-force-6',
      unitId: 'unit-force-6',
      kind: 'day_before',
    });

    const result = await forceSendReminder(row.reminderId, tour.tourId, FORCE_NOW, true, deps);

    expect(result).toEqual({ outcome: 'refused', reason: 'no_consent' });
    expect(spy.sent).toHaveLength(0);
    const after = (await tourReminders.listByTour(tour.tourId)).find(
      (r) => r.reminderId === row.reminderId,
    );
    expect(after?.sentAt).toBeUndefined();
    expect(after?.skippedAt).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // Send now 6b - a SOFT-DELETED contact refuses PRE-claim. sendMessage refuses
  // any 1:1 to a deleted contact (ContactDeletedError), so without this gate the
  // click would claim the row (the claim IS the sentAt stamp) and only then
  // throw - burning the rung for a state we can check up front.
  // ---------------------------------------------------------------------------
  it('force-send refuses contact_deleted WITHOUT claiming (the rung stays pending)', async () => {
    const rig = createGroupTestRig();
    const spy = makeForceSendSpy();
    const deps = { ...rig.deps, sendMessageService: spy.service, settingsRepo: stubSettingsRepo() };
    seedForceTenant(rig.world, {
      contactId: 'contact-force-6b',
      phone: '+15550220016',
      convId: 'conv-force-6b',
      now: SEEDED_AT,
      deletedAt: '2026-02-09T18:00:00.000Z',
    });
    const { tour, row } = await seedForceTour({
      tenantId: 'contact-force-6b',
      unitId: 'unit-force-6b',
      kind: 'day_before',
    });

    const result = await forceSendReminder(row.reminderId, tour.tourId, FORCE_NOW, true, deps);

    expect(result).toEqual({ outcome: 'refused', reason: 'contact_deleted' });
    expect(spy.sent).toHaveLength(0);
    const after = (await tourReminders.listByTour(tour.tourId)).find(
      (r) => r.reminderId === row.reminderId,
    );
    // The row is UNTOUCHED: restoring the contact must still leave it deliverable.
    expect(after?.sentAt).toBeUndefined();
    expect(after?.skippedAt).toBeUndefined();
    expect(after?.canceledAt).toBeUndefined();
    expect((await tourReminders.listDue('2026-02-11T13:01:00.000Z')).map((r) => r.reminderId)).toContain(
      row.reminderId,
    );
  });

  // ---------------------------------------------------------------------------
  // Send now 7 - an unresolvable target REFUSES; it must NOT claim-skip the rung
  // (the poller still gets its chance at dueAt)
  // ---------------------------------------------------------------------------
  it('force-send refuses no_conversation WITHOUT claim-skipping (the rung survives for the poller)', async () => {
    const rig = createGroupTestRig();
    const spy = makeForceSendSpy();
    const deps = { ...rig.deps, sendMessageService: spy.service, settingsRepo: stubSettingsRepo() };
    // Contact + phone, but NO conversation anywhere in this world.
    seedForceTenant(rig.world, {
      contactId: 'contact-force-7',
      phone: '+15550220007',
      now: SEEDED_AT,
    });
    const { tour, row } = await seedForceTour({
      tenantId: 'contact-force-7',
      unitId: 'unit-force-7',
      kind: 'day_before',
    });

    const result = await forceSendReminder(row.reminderId, tour.tourId, FORCE_NOW, true, deps);

    expect(result).toEqual({ outcome: 'refused', reason: 'no_conversation' });
    const after = (await tourReminders.listByTour(tour.tourId)).find(
      (r) => r.reminderId === row.reminderId,
    );
    expect(after?.skippedAt).toBeUndefined();
    expect(after?.skipReason).toBeUndefined();
    expect(after?.sentAt).toBeUndefined();
    // Still live for the poll at its own dueAt.
    expect((await tourReminders.listDue('2026-02-11T13:01:00.000Z')).map((r) => r.reminderId)).toContain(
      row.reminderId,
    );
  });

  // ---------------------------------------------------------------------------
  // Send now 8 - an unknown rung id refuses (never a 500)
  // ---------------------------------------------------------------------------
  it('force-send refuses tour_missing for a reminderId that is not on the tour', async () => {
    const rig = createGroupTestRig();
    const spy = makeForceSendSpy();
    const deps = { ...rig.deps, sendMessageService: spy.service, settingsRepo: stubSettingsRepo() };
    const { tour } = await seedForceTour({
      tenantId: 'contact-force-8',
      unitId: 'unit-force-8',
      kind: 'day_before',
    });

    const result = await forceSendReminder('reminder-does-not-exist', tour.tourId, FORCE_NOW, true, deps);

    expect(result).toEqual({ outcome: 'refused', reason: 'tour_missing' });
    expect(spy.sent).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // Send now 9 - a GROUP-routed tour force-sends through the SAME relay
  // announcement chain the poll uses (never the 1:1 service)
  // ---------------------------------------------------------------------------
  it('force-sends a GROUP-routed rung through the relay announcement path', async () => {
    const rig = createGroupTestRig();
    const spy = makeForceSendSpy();
    const deps = { ...rig.deps, sendMessageService: spy.service, settingsRepo: stubSettingsRepo() };
    const tenantPhone = '+15550220009';
    const landlordPhone = '+15550220019';
    const poolNumber = '+15550190029';
    const groupConvId = 'conv-group-force-9';

    seedForceTenant(rig.world, {
      contactId: 'contact-force-9',
      phone: tenantPhone,
      convId: 'conv-1to1-force-9',
      now: SEEDED_AT,
    });
    seedRelayGroup(rig.world, {
      convId: groupConvId,
      poolNumber,
      participants: [
        { contactId: 'contact-force-9', phone: tenantPhone, name: 'Tina Tenant' },
        { contactId: 'contact-force-9b', phone: landlordPhone, name: 'Larry Landlord' },
      ],
      now: SEEDED_AT,
    });

    const { tour, row } = await seedForceTour({
      tenantId: 'contact-force-9',
      unitId: 'unit-force-9',
      kind: 'confirmation',
      tourType: 'landlord_led',
    });
    await tours.patch(tour.tourId, { groupThreadId: groupConvId });

    const result = await forceSendReminder(row.reminderId, tour.tourId, FORCE_NOW, true, deps);

    expect(result).toEqual({ outcome: 'sent' });
    expect(rig.groupSends.map((s) => s.to).sort()).toEqual([tenantPhone, landlordPhone].sort());
    // Never the 1:1 service.
    expect(spy.sent).toHaveLength(0);
    const after = (await tourReminders.listByTour(tour.tourId)).find(
      (r) => r.reminderId === row.reminderId,
    );
    expect(after?.sentAt).toBe(FORCE_NOW);
  });

  // ---------------------------------------------------------------------------
  // Send now 10 - the narrow post-claim race (an opt-out landing between the
  // pre-check and the provider send): the claim is KEPT (poller parity) but the
  // outcome is reported honestly so the UI can show a real error.
  // ---------------------------------------------------------------------------
  it('a post-claim SendRefusedError returns refused_post_claim, keeps the claim, and sends nothing', async () => {
    const rig = createGroupTestRig();
    const spy = makeForceSendSpy({
      throwErr: new SendRefusedError('opted out mid-flight', 'contact_opted_out'),
    });
    const deps = { ...rig.deps, sendMessageService: spy.service, settingsRepo: stubSettingsRepo() };
    seedForceTenant(rig.world, {
      contactId: 'contact-force-10',
      phone: '+15550220010',
      convId: 'conv-force-10',
      now: SEEDED_AT,
    });
    const { tour, row } = await seedForceTour({
      tenantId: 'contact-force-10',
      unitId: 'unit-force-10',
      kind: 'day_before',
    });

    const result = await forceSendReminder(row.reminderId, tour.tourId, FORCE_NOW, true, deps);

    expect(result).toEqual({ outcome: 'refused_post_claim', reason: 'contact_opted_out' });
    // The claim IS the sentAt stamp - the row is consumed (poller parity).
    const after = (await tourReminders.listByTour(tour.tourId)).find(
      (r) => r.reminderId === row.reminderId,
    );
    expect(after?.sentAt).toBe(FORCE_NOW);
    // ZERO provider sends on either route.
    expect(rig.world.sent).toHaveLength(0);
    expect(rig.groupSends).toHaveLength(0);
    // A warn line records the refusal (ids + code only, never PII).
    const warns = logCapture.atLevel(40).filter((l) => l['reminderId'] === row.reminderId);
    expect(warns).toHaveLength(1);
    expect(warns[0]!['refusal']).toBe('contact_opted_out');
  });
});
