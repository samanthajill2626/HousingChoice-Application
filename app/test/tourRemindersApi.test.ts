// Tour reminders read endpoint tests — GET /api/tours/:tourId/reminders
// (scheduled-message-visibility, Task 2 Part A server).
//
//   GET /api/tours/:tourId/reminders
//        → { reminders: TourReminderView[]; next?: TourReminderView }
//
// Each reminder rung's state (upcoming|sent|canceled) + canned body, plus — for
// UPCOMING rungs that route 1:1 (a self_guided tour, the unambiguous 1:1 route
// for THIS task; Task 4 tightens the group-route case) — a send-time
// suppression estimate (opt-out / kill-switch / manual mode).
//
// Mirrors toursApi.test.ts: the full app via makeWebhookHarness with in-memory
// fakes (no DynamoDB, no network); reminders/tours/contacts/conversations are
// seeded directly on the world fakes.
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import type { ReminderKind, TourReminderItem } from '../src/repos/tourRemindersRepo.js';
import { composeTourReminderBody } from '../src/messages/tourCopy.js';
import {
  runDueTourReminders,
  type RunDueTourRemindersDeps,
} from '../src/jobs/tourReminders.js';
import type {
  SendMessageInput,
  SendMessageOutcome,
  SendMessageService,
} from '../src/services/sendMessage.js';
import { TEST_SESSION_COOKIE, TEST_SESSION_USER } from './helpers/authSession.js';
import { makeWebhookHarness, ORIGIN_SECRET, type FakeWorld } from './helpers/twilioWebhookHarness.js';
import {
  isoHoursFromNow,
  quietOffSettingsRepo,
  quietWindowAroundNow,
  quietWindowAwayFromNow,
} from './helpers/settingsStub.js';

const SECRET = ORIGIN_SECRET;

function authed(app: ReturnType<typeof makeWebhookHarness>['app']) {
  return {
    get: (path: string) =>
      request(app).get(path).set('x-origin-verify', SECRET).set('cookie', TEST_SESSION_COOKIE),
    patch: (path: string) =>
      request(app).patch(path).set('x-origin-verify', SECRET).set('cookie', TEST_SESSION_COOKIE),
    post: (path: string) =>
      request(app).post(path).set('x-origin-verify', SECRET).set('cookie', TEST_SESSION_COOKIE),
  };
}

/** Records every send the route drives (the route asserts on view + audit). */
function makeSendSpy(): { service: SendMessageService; sent: SendMessageInput[] } {
  const sent: SendMessageInput[] = [];
  const service: SendMessageService = async (input) => {
    sent.push(input);
    return {
      conversationId: input.conversationId,
      providerSid: 'SM-route-fake',
      tsMsgId: 'ts-route-fake',
      status: 'queued',
    } as SendMessageOutcome;
  };
  return { service, sent };
}

/**
 * The POLL's deps, assembled from the harness world. This suite has no `__dev`
 * routes (they are opt-in and never mounted here), so a parity test drives the
 * send by calling runDueTourReminders directly rather than through an HTTP tick.
 */
function pollDepsFrom(
  world: FakeWorld,
  sendMessageService: SendMessageService,
): RunDueTourRemindersDeps {
  return {
    tourRemindersRepo: world.tourRemindersRepo,
    toursRepo: world.toursRepo,
    contactsRepo: world.contactsRepo,
    conversationsRepo: world.conversationsRepo,
    messagesRepo: world.messagesRepo,
    unitsRepo: world.unitsRepo,
    adapter: world.adapter,
    sendMessageService,
    // Quiet hours OFF so the fire-time backstop is a no-op and the rung actually
    // sends at its fixture dueAt. With the default window a dueAt inside
    // 21:00-08:00 would DEFER and the assertion would see no send at all.
    settingsRepo: quietOffSettingsRepo(),
  };
}

/** Seed a reminder row directly on the world fake. */
function seedReminder(
  world: FakeWorld,
  input: {
    reminderId: string;
    tourId: string;
    kind: ReminderKind;
    dueAt: string;
    sentAt?: string;
    canceledAt?: string;
    skippedAt?: string;
    skipReason?: TourReminderItem['skipReason'];
  },
): void {
  const item: TourReminderItem = {
    reminderId: input.reminderId,
    tourId: input.tourId,
    kind: input.kind,
    dueAt: input.dueAt,
    _reminderPartition: 'reminders',
    createdAt: '2026-07-13T00:00:00.000Z',
    ...(input.sentAt !== undefined && { sentAt: input.sentAt }),
    ...(input.canceledAt !== undefined && { canceledAt: input.canceledAt }),
    ...(input.skippedAt !== undefined && { skippedAt: input.skippedAt }),
    ...(input.skipReason !== undefined && { skipReason: input.skipReason }),
  };
  world.tourRemindersMap.set(item.reminderId, item);
}

/**
 * Seed a tenant + their 1:1 thread + a self_guided tour (the unambiguous 1:1
 * route, the only shape that gets a suppression estimate) and return its tourId.
 * Nothing here suppresses on its own, so the quiet cases below assert purely on
 * each rung's dueAt.
 */
async function seedQuietTour(world: FakeWorld, suffix: string, phone: string): Promise<string> {
  const tenantId = `contact-quiet-${suffix}`;
  world.contacts.push({
    contactId: tenantId,
    type: 'tenant',
    phone,
    created_at: '2026-07-13T00:00:00.000Z',
  } as Parameters<typeof world.contacts.push>[0]);
  world.conversations.set(`conv-quiet-${suffix}`, {
    conversationId: `conv-quiet-${suffix}`,
    participant_phone: phone,
    status: 'open',
    type: 'tenant_1to1',
    ai_mode: 'auto',
    last_activity_at: '2026-07-13T00:00:00.000Z',
    created_at: '2026-07-13T00:00:00.000Z',
  });
  const created = await world.toursRepo.create({
    tenantId,
    unitId: `unit-quiet-${suffix}`,
    scheduledAt: '2099-01-10T10:00:00.000Z',
    tourType: 'self_guided',
  });
  return created.tourId;
}

describe('GET /api/tours/:tourId/reminders', () => {
  it('returns each rung sorted by dueAt asc with state + body, and next = earliest upcoming', async () => {
    const { app, world } = makeWebhookHarness();

    // A landlord_led tour: non-self_guided, so THIS task never computes a
    // suppression estimate (leaving state/body/sort/next the sole assertions).
    const created = await world.toursRepo.create({
      tenantId: 'contact-states-1',
      unitId: 'unit-states-1',
      scheduledAt: '2026-07-15T10:00:00.000Z',
      tourType: 'landlord_led',
    });
    const tourId = created.tourId;

    // Three rungs (seeded out of dueAt order to prove the server sorts):
    seedReminder(world, {
      reminderId: 'rem-morning',
      tourId,
      kind: 'morning_of',
      dueAt: '2026-07-15T08:00:00.000Z',
      canceledAt: '2026-07-14T09:00:00.000Z',
    });
    seedReminder(world, {
      reminderId: 'rem-confirm',
      tourId,
      kind: 'confirmation',
      dueAt: '2026-07-13T10:00:00.000Z',
      sentAt: '2026-07-13T10:00:05.000Z',
    });
    seedReminder(world, {
      reminderId: 'rem-daybefore',
      tourId,
      kind: 'day_before',
      dueAt: '2026-07-14T10:00:00.000Z',
    });

    const res = await authed(app).get(`/api/tours/${tourId}/reminders`);
    expect(res.status).toBe(200);

    const { reminders, next } = res.body as {
      reminders: {
        reminderId: string;
        kind: ReminderKind;
        dueAt: string;
        state: string;
        body: string;
        sentAt?: string;
        canceledAt?: string;
        suppression?: { reason: string };
      }[];
      next?: { reminderId: string; kind: ReminderKind; state: string };
    };

    // Sorted ascending by dueAt: confirmation, day_before, morning_of.
    expect(reminders.map((r) => r.kind)).toEqual(['confirmation', 'day_before', 'morning_of']);
    expect(reminders.map((r) => r.state)).toEqual(['sent', 'upcoming', 'canceled']);

    // Bodies are the composed rung text: this tour's instant in the org zone
    // the route composes in, with no address ('unit-states-1' is not seeded).
    for (const r of reminders) {
      expect(r.body).toBe(
        composeTourReminderBody({
          kind: r.kind,
          scheduledAt: '2026-07-15T10:00:00.000Z',
          timezone: world.settings.timezone,
        }),
      );
      // No suppression estimate on a non-self_guided tour (Task 2 scope).
      expect(r.suppression).toBeUndefined();
    }

    // sentAt / canceledAt surfaced on the respective rungs.
    expect(reminders.find((r) => r.kind === 'confirmation')?.sentAt).toBe('2026-07-13T10:00:05.000Z');
    expect(reminders.find((r) => r.kind === 'morning_of')?.canceledAt).toBe('2026-07-14T09:00:00.000Z');

    // next = the earliest upcoming rung (day_before).
    expect(next?.kind).toBe('day_before');
    expect(next?.state).toBe('upcoming');
    expect(next?.reminderId).toBe('rem-daybefore');
  });

  it('surfaces a claim-skipped rung as state "skipped" with skipReason, excluded from next', async () => {
    const { app, world } = makeWebhookHarness();

    const created = await world.toursRepo.create({
      tenantId: 'contact-skipview-1',
      unitId: 'unit-skipview-1',
      scheduledAt: '2026-07-15T10:00:00.000Z',
      tourType: 'landlord_led',
    });
    const tourId = created.tourId;

    // A rung the poll retired unsent + a genuinely upcoming one.
    seedReminder(world, {
      reminderId: 'rem-skipped',
      tourId,
      kind: 'confirmation',
      dueAt: '2026-07-13T10:00:00.000Z',
      skippedAt: '2026-07-13T10:01:00.000Z',
      skipReason: 'no_conversation',
    });
    seedReminder(world, {
      reminderId: 'rem-upcoming',
      tourId,
      kind: 'day_before',
      dueAt: '2026-07-14T10:00:00.000Z',
    });

    const res = await authed(app).get(`/api/tours/${tourId}/reminders`);
    expect(res.status).toBe(200);
    const { reminders, next } = res.body as {
      reminders: { reminderId: string; state: string; skippedAt?: string; skipReason?: string }[];
      next?: { reminderId: string };
    };

    const skipped = reminders.find((r) => r.reminderId === 'rem-skipped');
    expect(skipped?.state).toBe('skipped');
    expect(skipped?.skippedAt).toBe('2026-07-13T10:01:00.000Z');
    expect(skipped?.skipReason).toBe('no_conversation');

    // A skipped rung is terminal — never the NEXT rung to fire.
    expect(next?.reminderId).toBe('rem-upcoming');
  });

  it('carries a contact_opted_out suppression estimate on an upcoming 1:1 (self_guided) rung', async () => {
    const { app, world } = makeWebhookHarness();

    const tenantPhone = '+15550600001';
    const tenantId = 'contact-optout-1';

    // Opted-out tenant contact (contact-level sms_opt_out).
    world.contacts.push({
      contactId: tenantId,
      type: 'tenant',
      phone: tenantPhone,
      sms_opt_out: true,
      created_at: '2026-07-13T00:00:00.000Z',
    } as Parameters<typeof world.contacts.push>[0]);
    // Their 1:1 conversation (resolved by participant phone).
    world.conversations.set('conv-optout-1', {
      conversationId: 'conv-optout-1',
      participant_phone: tenantPhone,
      status: 'open',
      type: 'tenant_1to1',
      ai_mode: 'auto',
      last_activity_at: '2026-07-13T00:00:00.000Z',
      created_at: '2026-07-13T00:00:00.000Z',
    });

    const created = await world.toursRepo.create({
      tenantId,
      unitId: 'unit-optout-1',
      scheduledAt: '2026-07-15T10:00:00.000Z',
      tourType: 'self_guided',
    });
    const tourId = created.tourId;

    seedReminder(world, {
      reminderId: 'rem-optout-daybefore',
      tourId,
      kind: 'day_before',
      dueAt: '2026-07-14T10:00:00.000Z',
    });

    const res = await authed(app).get(`/api/tours/${tourId}/reminders`);
    expect(res.status).toBe(200);

    const upcoming = (res.body.reminders as { state: string; suppression?: { reason: string } }[]).find(
      (r) => r.state === 'upcoming',
    );
    expect(upcoming?.suppression).toEqual({ reason: 'contact_opted_out' });
  });

  // Quiet hours (spec 2026-08-03): the chip is a claim about the FUTURE ("Will
  // wait"), so it is a property of the RUNG - its own dueAt against the
  // daily-recurring window - not of the server wall clock. The window stub is
  // still built from the current time (never a fixed 21:00-08:00, which would
  // make these cases pass or fail depending on when the suite runs).
  it('carries a quiet_hours suppression estimate for a rung due inside a window occurrence', async () => {
    const { app, world } = makeWebhookHarness();
    Object.assign(world.settings, quietWindowAroundNow());
    const tourId = await seedQuietTour(world, 'view-1', '+15550600011');
    // Same wall time tomorrow: inside TOMORROW's occurrence of the window.
    seedReminder(world, {
      reminderId: 'rem-quiet-view-1',
      tourId,
      kind: 'day_before',
      dueAt: isoHoursFromNow(24),
    });

    const res = await authed(app).get(`/api/tours/${tourId}/reminders`);
    expect(res.status).toBe(200);
    const upcoming = (res.body.reminders as { state: string; suppression?: { reason: string } }[]).find(
      (r) => r.state === 'upcoming',
    );
    expect(upcoming?.suppression).toEqual({ reason: 'quiet_hours' });
  });

  // The SF1 false positive: at 03:00 the wall clock is quiet, but a rung due
  // Friday afternoon will not wait for anything, so it must NOT be chipped -
  // while a rung already due IS being held by the fire-time backstop right now.
  it('inside the window, chips only what quiet hours will hold - not every upcoming rung', async () => {
    const { app, world } = makeWebhookHarness();
    Object.assign(world.settings, quietWindowAroundNow());
    const tourId = await seedQuietTour(world, 'view-5', '+15550600015');
    // Three days out at a time of day outside EVERY occurrence of the window.
    seedReminder(world, {
      reminderId: 'rem-quiet-far',
      tourId,
      kind: 'day_before',
      dueAt: isoHoursFromNow(3 * 24 + 6),
    });
    // Already due, with a dueAt outside every occurrence: the poll is deferring
    // it RIGHT NOW (worker-downtime catch-up that crossed the window start).
    seedReminder(world, {
      reminderId: 'rem-quiet-overdue',
      tourId,
      kind: 'confirmation',
      dueAt: isoHoursFromNow(-30),
    });

    const res = await authed(app).get(`/api/tours/${tourId}/reminders`);
    expect(res.status).toBe(200);
    const byId = new Map(
      (res.body.reminders as { reminderId: string; suppression?: { reason: string } }[]).map((r) => [
        r.reminderId,
        r,
      ]),
    );
    expect(byId.get('rem-quiet-far')?.suppression).toBeUndefined();
    expect(byId.get('rem-quiet-overdue')?.suppression).toEqual({ reason: 'quiet_hours' });
  });

  // The other half of SF1: during business hours a rung genuinely due at 23:00
  // tonight WILL be deferred, so it must chip even though the clock is outside
  // the window - exactly when staff are looking at the panel.
  it('outside the window, still chips a rung due inside tonight occurrence', async () => {
    const { app, world } = makeWebhookHarness();
    Object.assign(world.settings, quietWindowAwayFromNow());
    const tourId = await seedQuietTour(world, 'view-6', '+15550600016');
    seedReminder(world, {
      reminderId: 'rem-quiet-tonight',
      tourId,
      kind: 'day_before',
      dueAt: isoHoursFromNow(4), // inside tonight's occurrence
    });
    seedReminder(world, {
      reminderId: 'rem-quiet-before',
      tourId,
      kind: 'confirmation',
      dueAt: isoHoursFromNow(1), // future, but before the window opens
    });

    const res = await authed(app).get(`/api/tours/${tourId}/reminders`);
    expect(res.status).toBe(200);
    const byId = new Map(
      (res.body.reminders as { reminderId: string; suppression?: { reason: string } }[]).map((r) => [
        r.reminderId,
        r,
      ]),
    );
    expect(byId.get('rem-quiet-tonight')?.suppression).toEqual({ reason: 'quiet_hours' });
    expect(byId.get('rem-quiet-before')?.suppression).toBeUndefined();
  });

  // N1 (stalled-poller edge): once the window has ENDED, an overdue rung is one
  // poll tick from sending - "Will wait" would be a lie about the past. Its
  // in-window dueAt must not chip it via the rung-time disjunct; only a rung
  // still in the FUTURE reads its own dueAt against the window.
  it('outside the window, an OVERDUE rung with an in-window dueAt is not chipped', async () => {
    const { app, world } = makeWebhookHarness();
    Object.assign(world.settings, quietWindowAwayFromNow());
    const tourId = await seedQuietTour(world, 'view-7', '+15550600017');
    // Overdue, and its wall time sits inside a PAST occurrence of the window
    // (-20h = the same wall time as +4h): the poller already released it when
    // that occurrence ended, so nothing is holding it now.
    seedReminder(world, {
      reminderId: 'rem-quiet-staleheld',
      tourId,
      kind: 'confirmation',
      dueAt: isoHoursFromNow(-20),
    });

    const res = await authed(app).get(`/api/tours/${tourId}/reminders`);
    expect(res.status).toBe(200);
    const upcoming = (res.body.reminders as { state: string; suppression?: { reason: string } }[]).find(
      (r) => r.state === 'upcoming',
    );
    expect(upcoming?.suppression).toBeUndefined();
  });

  it('carries NO suppression when quiet hours are disabled (nothing else suppresses)', async () => {
    const { app, world } = makeWebhookHarness();
    world.settings.quietHoursEnabled = false;

    const tenantPhone = '+15550600012';
    const tenantId = 'contact-quiet-view-2';
    world.contacts.push({
      contactId: tenantId,
      type: 'tenant',
      phone: tenantPhone,
      created_at: '2026-07-13T00:00:00.000Z',
    } as Parameters<typeof world.contacts.push>[0]);
    world.conversations.set('conv-quiet-view-2', {
      conversationId: 'conv-quiet-view-2',
      participant_phone: tenantPhone,
      status: 'open',
      type: 'tenant_1to1',
      ai_mode: 'auto',
      last_activity_at: '2026-07-13T00:00:00.000Z',
      created_at: '2026-07-13T00:00:00.000Z',
    });

    const created = await world.toursRepo.create({
      tenantId,
      unitId: 'unit-quiet-view-2',
      scheduledAt: '2026-07-15T10:00:00.000Z',
      tourType: 'self_guided',
    });
    seedReminder(world, {
      reminderId: 'rem-quiet-view-2',
      tourId: created.tourId,
      kind: 'day_before',
      dueAt: '2026-07-14T10:00:00.000Z',
    });

    const res = await authed(app).get(`/api/tours/${created.tourId}/reminders`);
    expect(res.status).toBe(200);
    const upcoming = (res.body.reminders as { state: string; suppression?: { reason: string } }[]).find(
      (r) => r.state === 'upcoming',
    );
    expect(upcoming?.suppression).toBeUndefined();
  });

  it('a harder reason still outranks quiet hours (opted-out tenant inside the window)', async () => {
    const { app, world } = makeWebhookHarness();
    Object.assign(world.settings, quietWindowAroundNow());

    const tenantPhone = '+15550600013';
    const tenantId = 'contact-quiet-view-3';
    world.contacts.push({
      contactId: tenantId,
      type: 'tenant',
      phone: tenantPhone,
      sms_opt_out: true,
      created_at: '2026-07-13T00:00:00.000Z',
    } as Parameters<typeof world.contacts.push>[0]);
    world.conversations.set('conv-quiet-view-3', {
      conversationId: 'conv-quiet-view-3',
      participant_phone: tenantPhone,
      status: 'open',
      type: 'tenant_1to1',
      ai_mode: 'auto',
      last_activity_at: '2026-07-13T00:00:00.000Z',
      created_at: '2026-07-13T00:00:00.000Z',
    });

    const created = await world.toursRepo.create({
      tenantId,
      unitId: 'unit-quiet-view-3',
      scheduledAt: '2026-07-15T10:00:00.000Z',
      tourType: 'self_guided',
    });
    // A dueAt inside tomorrow's occurrence, so quiet hours WOULD chip this rung
    // on its own - the opt-out has to outrank it, not merely fill a gap.
    seedReminder(world, {
      reminderId: 'rem-quiet-view-3',
      tourId: created.tourId,
      kind: 'day_before',
      dueAt: isoHoursFromNow(24),
    });

    const res = await authed(app).get(`/api/tours/${created.tourId}/reminders`);
    expect(res.status).toBe(200);
    const upcoming = (res.body.reminders as { state: string; suppression?: { reason: string } }[]).find(
      (r) => r.state === 'upcoming',
    );
    expect(upcoming?.suppression).toEqual({ reason: 'contact_opted_out' });
  });

  it('returns 404 for an unknown tour id', async () => {
    const { app } = makeWebhookHarness();
    const res = await authed(app).get('/api/tours/no-such-tour/reminders');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'tour_not_found' });
  });
});

// Operator cancel/restore of ONE rung (2026-07-14).
describe('PATCH /api/tours/:tourId/reminders/:reminderId', () => {
  async function seedTourWithRung(world: FakeWorld) {
    const created = await world.toursRepo.create({
      tenantId: 'contact-cancel-1',
      unitId: 'unit-cancel-1',
      scheduledAt: '2026-07-20T10:00:00.000Z',
      tourType: 'landlord_led',
    });
    seedReminder(world, {
      reminderId: 'rem-cancelable',
      tourId: created.tourId,
      kind: 'day_before',
      dueAt: '2026-07-19T10:00:00.000Z',
    });
    return created.tourId;
  }

  it('cancels an upcoming rung (emits scheduled.updated), then restores it', async () => {
    const { app, world } = makeWebhookHarness();
    const tourId = await seedTourWithRung(world);
    world.emitted.length = 0;

    const canceled = await authed(app)
      .patch(`/api/tours/${tourId}/reminders/rem-cancelable`)
      .send({ canceled: true });
    expect(canceled.status).toBe(200);
    expect(canceled.body.reminder.state).toBe('canceled');
    expect(typeof canceled.body.reminder.canceledAt).toBe('string');
    // The panel + the timelines' Upcoming buckets refetch on this.
    expect(
      world.emitted.some(
        (e) => e.event === 'scheduled.updated' && (e.payload as { contactId?: string }).contactId === 'contact-cancel-1',
      ),
    ).toBe(true);
    // A canceled rung leaves listDue — the poll can never fire it.
    expect(await world.tourRemindersRepo.listDue('2026-07-19T10:01:00.000Z')).toEqual([]);

    const restored = await authed(app)
      .patch(`/api/tours/${tourId}/reminders/rem-cancelable`)
      .send({ canceled: false });
    expect(restored.status).toBe(200);
    expect(restored.body.reminder.state).toBe('upcoming');
    expect(restored.body.reminder.canceledAt).toBeUndefined();
    // Restored → back in listDue at its original dueAt.
    expect(
      (await world.tourRemindersRepo.listDue('2026-07-19T10:01:00.000Z')).map((r) => r.reminderId),
    ).toEqual(['rem-cancelable']);
  });

  it('409s a cancel that lost to the send (honest state in the body)', async () => {
    const { app, world } = makeWebhookHarness();
    const tourId = await seedTourWithRung(world);
    // The poll fired the rung first.
    await world.tourRemindersRepo.claimSend('rem-cancelable', '2026-07-19T10:00:05.000Z');

    const res = await authed(app)
      .patch(`/api/tours/${tourId}/reminders/rem-cancelable`)
      .send({ canceled: true });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('reminder_not_cancelable');
    expect(res.body.reminder.state).toBe('sent');
  });

  it('409s restoring a rung that is not canceled', async () => {
    const { app, world } = makeWebhookHarness();
    const tourId = await seedTourWithRung(world);

    const res = await authed(app)
      .patch(`/api/tours/${tourId}/reminders/rem-cancelable`)
      .send({ canceled: false });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('reminder_not_restorable');
    expect(res.body.reminder.state).toBe('upcoming');
  });

  it('validates: 400 non-boolean, 404 unknown tour, 404 rung of ANOTHER tour', async () => {
    const { app, world } = makeWebhookHarness();
    const tourId = await seedTourWithRung(world);

    const bad = await authed(app)
      .patch(`/api/tours/${tourId}/reminders/rem-cancelable`)
      .send({ canceled: 'yes' });
    expect(bad.status).toBe(400);

    const ghostTour = await authed(app)
      .patch('/api/tours/no-such-tour/reminders/rem-cancelable')
      .send({ canceled: true });
    expect(ghostTour.status).toBe(404);

    // A real rung, but owned by a DIFFERENT tour — never mutable through this path.
    const other = await world.toursRepo.create({
      tenantId: 'contact-cancel-2',
      unitId: 'unit-cancel-2',
      scheduledAt: '2026-07-21T10:00:00.000Z',
      tourType: 'landlord_led',
    });
    const cross = await authed(app)
      .patch(`/api/tours/${other.tourId}/reminders/rem-cancelable`)
      .send({ canceled: true });
    expect(cross.status).toBe(404);
    expect(cross.body).toEqual({ error: 'reminder_not_found' });
  });
});

// Send now (quiet-hours spec section 7): any authed staff role - no admin gate
// (staff can already send the equivalent text from the composer).
describe('POST /api/tours/:tourId/reminders/:reminderId/send-now', () => {
  /** A tenant with a phone, RECORDED CONSENT and a 1:1 thread + one pending rung. */
  async function seedSendNowTour(
    world: FakeWorld,
    over: {
      contactOptOut?: boolean;
      consent?: boolean;
      suffix?: string;
      /** Soft-delete stamp (contactsRepo isDeleted reads a non-empty deleted_at). */
      deletedAt?: string;
    } = {},
  ) {
    const suffix = over.suffix ?? '1';
    const tenantId = `contact-sendnow-${suffix}`;
    const phone = `+1555070${suffix.padStart(4, '0')}`;
    world.contacts.push({
      contactId: tenantId,
      type: 'tenant',
      phone,
      created_at: '2026-07-13T00:00:00.000Z',
      ...(over.consent !== false && { consent_method: 'inbound_text' }),
      ...(over.contactOptOut === true && { sms_opt_out: true }),
      ...(over.deletedAt !== undefined && { deleted_at: over.deletedAt }),
    } as Parameters<typeof world.contacts.push>[0]);
    world.conversations.set(`conv-sendnow-${suffix}`, {
      conversationId: `conv-sendnow-${suffix}`,
      participant_phone: phone,
      status: 'open',
      type: 'tenant_1to1',
      ai_mode: 'auto',
      last_activity_at: '2026-07-13T00:00:00.000Z',
      created_at: '2026-07-13T00:00:00.000Z',
    });
    const created = await world.toursRepo.create({
      tenantId,
      unitId: `unit-sendnow-${suffix}`,
      scheduledAt: '2026-07-20T14:00:00.000Z',
      tourType: 'self_guided',
    });
    seedReminder(world, {
      reminderId: `rem-sendnow-${suffix}`,
      tourId: created.tourId,
      kind: 'day_before',
      dueAt: '2026-07-19T14:00:00.000Z',
    });
    return { tourId: created.tourId, reminderId: `rem-sendnow-${suffix}`, tenantId };
  }

  it('200s with the re-read sent view, sends automated: false, and records an audit event', async () => {
    const spy = makeSendSpy();
    const { app, world } = makeWebhookHarness({ sendMessageService: spy.service });
    // Quiet hours ON around the wall clock: the human path must ignore them.
    Object.assign(world.settings, quietWindowAroundNow());
    const { tourId, reminderId } = await seedSendNowTour(world);

    const res = await authed(app).post(`/api/tours/${tourId}/reminders/${reminderId}/send-now`);

    expect(res.status).toBe(200);
    expect(res.body.reminder.reminderId).toBe(reminderId);
    expect(res.body.reminder.state).toBe('sent');
    expect(typeof res.body.reminder.sentAt).toBe('string');
    // The snapshot the force-send claimed, composed in the zone the settings
    // stub above installs (quietWindowAroundNow evaluates in UTC), with no
    // address ('unit-sendnow-1' is not seeded).
    expect(res.body.reminder.body).toBe(
      composeTourReminderBody({
        kind: 'day_before',
        scheduledAt: '2026-07-20T14:00:00.000Z',
        timezone: world.settings.timezone,
      }),
    );

    // The send went out as a HUMAN send.
    expect(spy.sent).toHaveLength(1);
    expect(spy.sent[0]!.conversationId).toBe('conv-sendnow-1');
    expect(spy.sent[0]!.automated).toBe(false);

    // Who clicked is recorded on the tour's trail.
    const ev = world.auditEvents.find((e) => e.event_type === 'reminder_force_sent');
    expect(ev?.entityKey).toBe(`tours#${tourId}`);
    expect(ev?.actorId).toBe(TEST_SESSION_USER.userId);
    expect(ev?.payload).toEqual({
      reminderId,
      kind: 'day_before',
      actor: TEST_SESSION_USER.userId,
    });
  });

  it('409s reminder_not_pending with the honest current view when the rung already fired', async () => {
    const spy = makeSendSpy();
    const { app, world } = makeWebhookHarness({ sendMessageService: spy.service });
    const { tourId, reminderId } = await seedSendNowTour(world, { suffix: '2' });
    await world.tourRemindersRepo.claimSend(reminderId, '2026-07-19T14:00:05.000Z');

    const res = await authed(app).post(`/api/tours/${tourId}/reminders/${reminderId}/send-now`);

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('reminder_not_pending');
    expect(res.body.reminder.state).toBe('sent');
    expect(spy.sent).toHaveLength(0);
    expect(world.auditEvents.some((e) => e.event_type === 'reminder_force_sent')).toBe(false);
  });

  it('409s contact_opted_out and leaves the rung upcoming (a refusal never consumes the row)', async () => {
    const spy = makeSendSpy();
    const { app, world } = makeWebhookHarness({ sendMessageService: spy.service });
    const { tourId, reminderId } = await seedSendNowTour(world, {
      suffix: '3',
      contactOptOut: true,
    });

    const res = await authed(app).post(`/api/tours/${tourId}/reminders/${reminderId}/send-now`);

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('contact_opted_out');
    expect(res.body.reminder.state).toBe('upcoming');
    expect(spy.sent).toHaveLength(0);
    // Still pending for the poll at its own dueAt.
    expect(
      (await world.tourRemindersRepo.listDue('2026-07-19T14:01:00.000Z')).map((r) => r.reminderId),
    ).toContain(reminderId);
  });

  it('409s no_consent for a contact with no recorded consent', async () => {
    const spy = makeSendSpy();
    const { app, world } = makeWebhookHarness({ sendMessageService: spy.service });
    const { tourId, reminderId } = await seedSendNowTour(world, { suffix: '4', consent: false });

    const res = await authed(app).post(`/api/tours/${tourId}/reminders/${reminderId}/send-now`);

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('no_consent');
    expect(res.body.reminder.state).toBe('upcoming');
    expect(spy.sent).toHaveLength(0);
  });

  it('409s contact_deleted for a soft-deleted contact and leaves the rung upcoming', async () => {
    const spy = makeSendSpy();
    const { app, world } = makeWebhookHarness({ sendMessageService: spy.service });
    const { tourId, reminderId } = await seedSendNowTour(world, {
      suffix: '6',
      deletedAt: '2026-07-12T00:00:00.000Z',
    });

    const res = await authed(app).post(`/api/tours/${tourId}/reminders/${reminderId}/send-now`);

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('contact_deleted');
    expect(res.body.reminder.state).toBe('upcoming');
    expect(spy.sent).toHaveLength(0);
  });

  it('404s an unknown tour, an unknown rung, and a rung owned by ANOTHER tour', async () => {
    const spy = makeSendSpy();
    const { app, world } = makeWebhookHarness({ sendMessageService: spy.service });
    const { tourId, reminderId } = await seedSendNowTour(world, { suffix: '5' });

    const ghostTour = await authed(app).post(
      `/api/tours/no-such-tour/reminders/${reminderId}/send-now`,
    );
    expect(ghostTour.status).toBe(404);
    expect(ghostTour.body).toEqual({ error: 'tour_not_found' });

    const ghostRung = await authed(app).post(
      `/api/tours/${tourId}/reminders/rem-does-not-exist/send-now`,
    );
    expect(ghostRung.status).toBe(404);
    expect(ghostRung.body).toEqual({ error: 'reminder_not_found' });

    const other = await world.toursRepo.create({
      tenantId: 'contact-sendnow-other',
      unitId: 'unit-sendnow-other',
      scheduledAt: '2026-07-21T14:00:00.000Z',
      tourType: 'self_guided',
    });
    const cross = await authed(app).post(
      `/api/tours/${other.tourId}/reminders/${reminderId}/send-now`,
    );
    expect(cross.status).toBe(404);
    expect(cross.body).toEqual({ error: 'reminder_not_found' });
    expect(spy.sent).toHaveLength(0);
  });
});

// ===========================================================================
// Composed bodies: preview/send parity (T7) and sent-rung history (T8).
//
// The panel renders the GET's `body` as "this is what will be sent", so the
// preview and the send path must build the string the SAME way - through the
// one composer. These tests are behavior-neutral today (every body is still
// the token-free catalog string); they earn their keep when the copy flips.
// ===========================================================================
describe('composed reminder bodies', () => {
  /**
   * seedQuietTour + the unit it points at (WITH a structured address) + one
   * pending rung. The address is load-bearing: without it both sides would
   * compose the no-address variant and the parity assertion would pass
   * vacuously once the copy carries a street.
   */
  async function seedComposedTour(
    world: FakeWorld,
    suffix: string,
    phone: string,
  ): Promise<{ tourId: string; reminderId: string }> {
    const tourId = await seedQuietTour(world, suffix, phone);
    world.units.set(`unit-quiet-${suffix}`, {
      unitId: `unit-quiet-${suffix}`,
      landlordId: `contact-landlord-${suffix}`,
      status: 'available',
      address: { line1: '412 Sender Way NW', city: 'Atlanta', state: 'GA', zip: '30318' },
      created_at: '2026-07-13T00:00:00.000Z',
      updated_at: '2026-07-13T00:00:00.000Z',
    });
    const reminderId = `rem-composed-${suffix}`;
    seedReminder(world, {
      reminderId,
      tourId,
      kind: 'confirmation',
      dueAt: '2026-01-10T10:00:00.000Z',
    });
    return { tourId, reminderId };
  }

  it('the GET preview body EQUALS what the send path composes', async () => {
    // W1: the panel renders this string as "what will be sent". If the preview
    // and the send path ever build it differently, the dashboard is lying.
    const { app, world } = makeWebhookHarness();
    const spy = makeSendSpy();
    const deps = pollDepsFrom(world, spy.service);
    const { tourId, reminderId } = await seedComposedTour(world, 'parity', '+15550710001');

    const listed = await authed(app).get(`/api/tours/${tourId}/reminders`);
    expect(listed.status).toBe(200);
    const preview = listed.body.reminders.find(
      (r: { reminderId: string }) => r.reminderId === reminderId,
    );
    expect(preview).toBeDefined();
    expect(preview.state).toBe('upcoming');

    await runDueTourReminders(preview.dueAt, deps);

    expect(spy.sent).toHaveLength(1);
    // EQUALITY is the invariant. The seeded address is what gives it teeth:
    // once the copy carries the street and the local time, a preview that
    // resolved the catalog directly would no longer match this send.
    expect(spy.sent.at(-1)?.body).toBe(preview.body);
  });

  it('a SENT rung keeps its original body after the tour is rescheduled', async () => {
    // D4: sent rows survive a reschedule (only PENDING rungs are canceled).
    // Without the claim-time snapshot a read path would recompose them with the
    // NEW time and claim we texted something we never texted - and disagree
    // with the thread, which still shows the original text.
    const { app, world } = makeWebhookHarness();
    const spy = makeSendSpy();
    const deps = pollDepsFrom(world, spy.service);
    const { tourId, reminderId } = await seedComposedTour(world, 'history', '+15550710002');

    const listed = await authed(app).get(`/api/tours/${tourId}/reminders`);
    const target = listed.body.reminders.find(
      (r: { reminderId: string }) => r.reminderId === reminderId,
    );
    expect(target).toBeDefined();
    await runDueTourReminders(target.dueAt, deps);

    const afterSend = await authed(app).get(`/api/tours/${tourId}/reminders`);
    const sentBefore = afterSend.body.reminders.find(
      (r: { reminderId: string }) => r.reminderId === reminderId,
    );
    expect(sentBefore.state).toBe('sent');
    // What the send path actually put on the wire is what the panel shows.
    expect(sentBefore.body).toBe(spy.sent.at(-1)?.body);

    // Reschedule on the fake directly - no status gate, no HTTP: the status
    // rules are not what this test is about.
    await world.toursRepo.patch(tourId, { scheduledAt: '2026-12-01T20:00:00.000Z' });

    const afterReschedule = await authed(app).get(`/api/tours/${tourId}/reminders`);
    const sentAfter = afterReschedule.body.reminders.find(
      (r: { reminderId: string }) => r.reminderId === reminderId,
    );
    expect(sentAfter.body).toBe(sentBefore.body);
  });
});

// ===========================================================================
// READ-PATH CONTAINMENT (spec F1). Composition is PARTIAL: a tour whose
// scheduledAt is unusable (a bad write, a legacy row) cannot produce a body.
// On a READ path that must degrade to `body: ''` - never a 500 that takes the
// whole ladder with it, and never a missing `body` field (it is required on the
// wire view, the dashboard mirror and TimelineScheduled).
// ===========================================================================
describe('uncomposable rungs on the tour-reminder read paths', () => {
  /** A self_guided tour whose scheduledAt was corrupted AFTER the ladder existed. */
  async function seedUncomposableTour(
    world: FakeWorld,
    suffix: string,
    phone: string,
  ): Promise<{ tourId: string; pendingId: string; sentId: string }> {
    const tourId = await seedQuietTour(world, suffix, phone);
    // Recorded consent, so the send-now case below reaches the COMPOSE instead
    // of stopping at the JIT consent gate (which runs above it, by design).
    Object.assign(
      world.contacts.find((c) => c.contactId === `contact-quiet-${suffix}`)!,
      { consent_method: 'inbound_text' },
    );
    const pendingId = `rem-bad-pending-${suffix}`;
    const sentId = `rem-bad-sent-${suffix}`;
    seedReminder(world, {
      reminderId: pendingId,
      tourId,
      kind: 'confirmation',
      dueAt: '2026-01-10T10:00:00.000Z',
    });
    seedReminder(world, {
      reminderId: sentId,
      tourId,
      kind: 'day_before',
      dueAt: '2026-01-09T10:00:00.000Z',
      sentAt: '2026-01-09T10:00:05.000Z',
    });
    // The claim-time snapshot the send path stamped (claimSend's third argument).
    world.tourRemindersMap.get(sentId)!.sentBody = 'What we actually texted';
    await world.toursRepo.patch(tourId, { scheduledAt: 'not-an-instant' });
    return { tourId, pendingId, sentId };
  }

  it('the GET list degrades to an empty body per rung - 200, ladder intact, snapshots preserved', async () => {
    const { app, world } = makeWebhookHarness();
    const { tourId, pendingId, sentId } = await seedUncomposableTour(world, 'read1', '+15550710011');

    const res = await authed(app).get(`/api/tours/${tourId}/reminders`);

    expect(res.status).toBe(200);
    const rungs = res.body.reminders as Array<{
      reminderId: string;
      kind: string;
      dueAt: string;
      state: string;
      body: string;
    }>;
    // The whole ladder still renders - only the text is empty.
    expect(rungs).toHaveLength(2);
    const pending = rungs.find((r) => r.reminderId === pendingId)!;
    expect(pending.body).toBe('');
    expect(pending.state).toBe('upcoming');
    expect(pending.kind).toBe('confirmation');
    expect(pending.dueAt).toBe('2026-01-10T10:00:00.000Z');
    // A SENT rung never recomposes, so an unusable tour time cannot erase what
    // was really sent.
    const sent = rungs.find((r) => r.reminderId === sentId)!;
    expect(sent.body).toBe('What we actually texted');
    expect(sent.state).toBe('sent');
  });

  it('PATCH echoes the same empty body instead of failing the cancel', async () => {
    const { app, world } = makeWebhookHarness();
    const { tourId, pendingId } = await seedUncomposableTour(world, 'read2', '+15550710012');

    const res = await authed(app)
      .patch(`/api/tours/${tourId}/reminders/${pendingId}`)
      .send({ canceled: true });

    expect(res.status).toBe(200);
    expect(res.body.reminder.state).toBe('canceled');
    expect(res.body.reminder.body).toBe('');
  });

  it('send-now refuses PRE-CLAIM with invalid_schedule and leaves the rung pending', async () => {
    // The send-path half of the same failure: a human click must not burn the
    // rung (claimSend IS the sentAt stamp), so the refusal happens above it.
    const spy = makeSendSpy();
    const { app, world } = makeWebhookHarness({ sendMessageService: spy.service });
    const { tourId, pendingId } = await seedUncomposableTour(world, 'read3', '+15550710013');

    const res = await authed(app).post(`/api/tours/${tourId}/reminders/${pendingId}/send-now`);

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('invalid_schedule');
    expect(res.body.reminder.state).toBe('upcoming');
    expect(res.body.reminder.body).toBe('');
    expect(spy.sent).toHaveLength(0);
    // Untouched: no sentAt, no skip stamp - still the poll's to deliver.
    expect(world.tourRemindersMap.get(pendingId)?.sentAt).toBeUndefined();
    expect(world.tourRemindersMap.get(pendingId)?.skippedAt).toBeUndefined();
  });
});
