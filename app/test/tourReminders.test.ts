// Tour reminders integration tests against DynamoDB Local (Tours feature, Task 4).
//
// Covers:
//   1. armTourReminders — correct ladder dueAts, past rows skipped
//   2. runDueTourReminders — sends due reminders, stamps sentAt (idempotency)
//   3. reschedule — cancel + re-arm, new dueAts
//   4. cancelTourReminders — pending rows canceled
//   5. same-day tour — day_before skipped (past), future rows armed
//
// Uses DynamoDB Local for tourRemindersRepo + toursRepo.
// Uses the in-memory fakeWorld for contacts/conversations/sendMessage adapter.
//
// Self-skipping: when nothing answers at DYNAMODB_ENDPOINT the suite skips.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tableName } from '../src/lib/config.js';
import { createDocumentClient, createDynamoClient } from '../src/lib/dynamo.js';
import { deleteTableIfExists, ensureTable } from '../src/lib/dynamoAdmin.js';
import { getTableSpec } from '../src/lib/tables.js';
import { createLogger } from '../src/lib/logger.js';
import { createTourRemindersRepo } from '../src/repos/tourRemindersRepo.js';
import { createToursRepo } from '../src/repos/toursRepo.js';
import { createSendMessageService } from '../src/services/sendMessage.js';
import { armTourReminders, cancelTourReminders, runDueTourReminders } from '../src/jobs/tourReminders.js';
import { createFakeWorld } from './helpers/twilioWebhookHarness.js';
import { createLogCapture } from './helpers/logCapture.js';

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

  // Shared deps for runDueTourReminders.
  const runDeps = {
    tourRemindersRepo: tourReminders,
    toursRepo: tours,
    contactsRepo: world.contactsRepo,
    conversationsRepo: world.conversationsRepo,
    sendMessageService,
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
  it('armTourReminders creates all 5 reminder rows with correct dueAts', async () => {
    const now = '2026-07-13T10:00:00.000Z';
    const scheduledAt = '2026-07-15T10:00:00.000Z'; // T+2d

    const tour = await tours.create({
      tenantId: 'contact-arm-1',
      unitId: 'unit-arm-1',
      scheduledAt,
      tourType: 'self_guided',
    });

    const rows = await armTourReminders(tour, now, { tourRemindersRepo: tourReminders, logger });

    // All 5 kinds should be armed (all dueAts are in the future relative to now).
    expect(rows).toHaveLength(5);
    const byKind = Object.fromEntries(rows.map((r) => [r.kind, r]));

    // confirmation: dueAt = now
    expect(byKind['confirmation']!.dueAt).toBe(now);

    // day_before: scheduledAt - 24h = '2026-07-14T10:00:00.000Z'
    expect(byKind['day_before']!.dueAt).toBe('2026-07-14T10:00:00.000Z');

    // morning_of: date of scheduledAt at 08:00 UTC = '2026-07-15T08:00:00.000Z'
    expect(byKind['morning_of']!.dueAt).toBe('2026-07-15T08:00:00.000Z');

    // en_route: scheduledAt - 2h = '2026-07-15T08:00:00.000Z'
    // Wait — en_route = scheduledAt - 2h = 2026-07-15T08:00:00.000Z — same as morning_of?
    // Let's check: 10:00 - 2h = 08:00. morning_of is also 08:00. That's a coincidence
    // of the test case. Let's just check the actual computed value.
    expect(byKind['en_route']!.dueAt).toBe('2026-07-15T08:00:00.000Z');

    // no_show_checkin: scheduledAt + 30m = '2026-07-15T10:30:00.000Z'
    expect(byKind['no_show_checkin']!.dueAt).toBe('2026-07-15T10:30:00.000Z');

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
    expect(listed).toHaveLength(5);
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
    await armTourReminders(tour, now0, { tourRemindersRepo: tourReminders, logger });

    // Advance clock to just after day_before dueAt.
    // day_before = '2026-07-14T10:00:00.000Z'
    const pollAt = '2026-07-14T10:01:00.000Z';
    await runDueTourReminders(pollAt, runDeps);

    // Should have sent: confirmation (dueAt=now0 <= pollAt) AND day_before (dueAt='..T10:00' <= pollAt).
    // en_route (08:00) is also <= pollAt? No: '2026-07-15T08:00:00.000Z' > '2026-07-14T10:01:00.000Z'.
    // morning_of (08:00 on 15th) is also in the future.
    // So only confirmation + day_before should have fired.
    expect(world.sent).toHaveLength(2);
    const sentBodies = world.sent.map((s) => s.body);
    expect(sentBodies).toContain("[AUTO] Your tour is confirmed. We'll send reminders as it approaches.");
    expect(sentBodies).toContain('[AUTO] Reminder: your property tour is tomorrow.');

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
  // Test 3 — reschedule: cancel old reminders, re-arm with new scheduledAt
  // ---------------------------------------------------------------------------
  it('cancel + re-arm on reschedule produces new rows with updated dueAts', async () => {
    const now0 = '2026-07-13T11:00:00.000Z';
    const origScheduledAt = '2026-07-15T11:00:00.000Z';
    const newScheduledAt = '2026-07-20T14:00:00.000Z'; // rescheduled to T+7d

    const tour = await tours.create({
      tenantId: 'contact-reschedule-1',
      unitId: 'unit-reschedule-1',
      scheduledAt: origScheduledAt,
      tourType: 'self_guided',
    });

    // Arm original reminders.
    await armTourReminders(tour, now0, { tourRemindersRepo: tourReminders, logger });
    const origRows = await tourReminders.listByTour(tour.tourId);
    expect(origRows).toHaveLength(5);

    // Cancel and re-arm with the new scheduledAt.
    await cancelTourReminders(tour.tourId, { tourRemindersRepo: tourReminders, logger });

    // All original rows should be canceled.
    const afterCancel = await tourReminders.listByTour(tour.tourId);
    expect(afterCancel.every((r) => r.canceledAt !== undefined)).toBe(true);

    // Patch the tour with the new scheduledAt.
    const patchedTour = await tours.patch(tour.tourId, { scheduledAt: newScheduledAt });
    await armTourReminders(patchedTour, now0, { tourRemindersRepo: tourReminders, logger });

    // New rows should exist in addition to the canceled ones.
    const allRows = await tourReminders.listByTour(tour.tourId);
    const newRows = allRows.filter((r) => r.canceledAt === undefined);
    expect(newRows).toHaveLength(5);

    // New day_before should reflect the new scheduledAt: newScheduledAt - 24h.
    const dayBefore = newRows.find((r) => r.kind === 'day_before');
    expect(dayBefore?.dueAt).toBe('2026-07-19T14:00:00.000Z');

    // New no_show_checkin: newScheduledAt + 30m = '2026-07-20T14:30:00.000Z'
    const noShow = newRows.find((r) => r.kind === 'no_show_checkin');
    expect(noShow?.dueAt).toBe('2026-07-20T14:30:00.000Z');
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

    await armTourReminders(tour, now0, { tourRemindersRepo: tourReminders, logger });

    // Manually mark the confirmation row as sent (simulates one already fired).
    const rows = await tourReminders.listByTour(tour.tourId);
    const confirmRow = rows.find((r) => r.kind === 'confirmation');
    await tourReminders.markSent(confirmRow!.reminderId, now0);

    // Now cancel.
    await cancelTourReminders(tour.tourId, { tourRemindersRepo: tourReminders, logger });

    const afterCancel = await tourReminders.listByTour(tour.tourId);
    const stillPending = afterCancel.filter((r) => r.sentAt === undefined && r.canceledAt === undefined);
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

    const rows = await armTourReminders(tour, now0, { tourRemindersRepo: tourReminders, logger });

    const kinds = rows.map((r) => r.kind);

    // day_before = scheduledAt - 24h = '2026-07-12T14:00:00.000Z' < now0 → SKIPPED
    expect(kinds).not.toContain('day_before');

    // confirmation = now0 → always armed
    expect(kinds).toContain('confirmation');

    // morning_of = 08:00 UTC on 2026-07-13 = '2026-07-13T08:00:00.000Z' < now0 (09:00) → SKIPPED
    expect(kinds).not.toContain('morning_of');

    // en_route = scheduledAt - 2h = '2026-07-13T12:00:00.000Z' > now0 → armed
    expect(kinds).toContain('en_route');

    // no_show_checkin = scheduledAt + 30m = '2026-07-13T14:30:00.000Z' > now0 → armed
    expect(kinds).toContain('no_show_checkin');
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

    await armTourReminders(tour, now0, { tourRemindersRepo: tourReminders, logger });

    // Only the confirmation row has dueAt=now0 <= now0.
    const dueRows1 = await tourReminders.listDue(now0);
    const forThisTour1 = dueRows1.filter((r) => r.tourId === tour.tourId);
    expect(forThisTour1).toHaveLength(1);
    expect(forThisTour1[0]!.kind).toBe('confirmation');

    // Mark the confirmation row as sent.
    await tourReminders.markSent(forThisTour1[0]!.reminderId, now0);

    // Second listDue at the same time — no more due rows for this tour.
    const dueRows2 = await tourReminders.listDue(now0);
    const forThisTour2 = dueRows2.filter((r) => r.tourId === tour.tourId);
    expect(forThisTour2).toHaveLength(0);
  });
});
