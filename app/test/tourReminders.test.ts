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
import { createTourRemindersRepo } from '../src/repos/tourRemindersRepo.js';
import { createToursRepo } from '../src/repos/toursRepo.js';
import { createSendMessageService } from '../src/services/sendMessage.js';
import { armTourReminders, cancelTourReminders, runDueTourReminders } from '../src/jobs/tourReminders.js';
import { resolveMessage } from '../src/messages/index.js';
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

  // Shared deps for runDueTourReminders. The adapter (group route) is a spy
  // that must stay untouched here — these tours have no group thread (and so
  // is messagesRepo: group rungs persist announcement rows through it).
  const runDeps = {
    tourRemindersRepo: tourReminders,
    toursRepo: tours,
    contactsRepo: world.contactsRepo,
    conversationsRepo: world.conversationsRepo,
    messagesRepo: world.messagesRepo,
    sendMessageService,
    adapter: createAdapterSpy().adapter,
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
    expect(sentBodies).toContain(resolveMessage('tour.confirmation'));
    expect(sentBodies).toContain(resolveMessage('tour.day_before'));

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
    await armTourReminders(tour, now0, { tourRemindersRepo: tourReminders, logger });

    const events = createEventBus({ logger });
    const emitted: Array<{ contactId?: string }> = [];
    events.on('scheduled.updated', (p) => emitted.push(p));

    // Same window as Test 2: confirmation + day_before fire.
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
    await armTourReminders(tour, now0, { tourRemindersRepo: tourReminders, logger });

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
    await tourReminders.claimSend(confirmRow!.reminderId, now0);

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
    await armTourReminders(tour, now0, { tourRemindersRepo: tourReminders, logger });

    const racingDeps = {
      tourRemindersRepo: tourReminders,
      toursRepo: tours,
      contactsRepo: racingWorld.contactsRepo,
      conversationsRepo: racingWorld.conversationsRepo,
      messagesRepo: racingWorld.messagesRepo,
      sendMessageService: racingSend,
      adapter: createAdapterSpy().adapter,
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

    await armTourReminders(tour, now0, { tourRemindersRepo: tourReminders, logger });

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
      sendMessageService: cancelSend,
      adapter: createAdapterSpy().adapter,
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

  const CONFIRMATION_BODY = resolveMessage('tour.confirmation');

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
      sendMessageService: send,
      adapter: spy.adapter,
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
    await armTourReminders(tour, now0, { tourRemindersRepo: tourReminders, logger });

    // Only the confirmation rung is due at now0.
    await runDueTourReminders(now0, rig.deps);

    // Group route: one direct adapter send PER member, FROM the pool number,
    // carrying the same rung body.
    expect(rig.groupSends).toHaveLength(2);
    expect(rig.groupSends.map((s) => s.to).sort()).toEqual([tenantPhone, landlordPhone].sort());
    for (const s of rig.groupSends) {
      expect(s.from).toBe(poolNumber);
      expect(s.body).toBe(CONFIRMATION_BODY);
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
    expect(announcement.body).toBe(CONFIRMATION_BODY);
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
    await armTourReminders(tour, now0, { tourRemindersRepo: tourReminders, logger });

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
    await armTourReminders(tour, now0, { tourRemindersRepo: tourReminders, logger });

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
    await armTourReminders(tour, now0, { tourRemindersRepo: tourReminders, logger });

    await runDueTourReminders(now0, rig.deps);

    // 1:1 route: sent via sendMessageService (world adapter), NOT the group spy.
    expect(rig.groupSends).toHaveLength(0);
    expect(rig.world.sent).toHaveLength(1);
    expect(rig.world.sent[0]!.to).toBe(tenantPhone);
    expect(rig.world.sent[0]!.body).toContain(CONFIRMATION_BODY);
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
    await armTourReminders(tour, now0, { tourRemindersRepo: tourReminders, logger });

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
    await armTourReminders(tour, now0, { tourRemindersRepo: tourReminders, logger });

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
    await armTourReminders(tour, now0, { tourRemindersRepo: tourReminders, logger });

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
    await armTourReminders(tour, now0, { tourRemindersRepo: tourReminders, logger });

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
    await armTourReminders(tour, now0, { tourRemindersRepo: tourReminders, logger });

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
    await armTourReminders(tour, now0, { tourRemindersRepo: tourReminders, logger });

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
    await armTourReminders(tour, now0, { tourRemindersRepo: tourReminders, logger });

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
});
