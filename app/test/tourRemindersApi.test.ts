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
  runDueTourReminders as runDueTourRemindersRaw,
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

/**
 * A harness whose tour-reminders route applies NO manual-only hold-back.
 *
 * Since 2026-08-20 every auto-armed rung kind is held back (founder decision),
 * and `paused` outranks quiet hours in the shared precedence ladder - so under
 * the production default EVERY upcoming rung chips `paused` and the estimates
 * these cases exist to prove become unobservable. They are testing the route's
 * per-row quiet-hours formula and its opt-out/kill-switch preview, not the
 * hold-back, so they switch the hold-back off; the hold-back has its own cases
 * ("manual-only hold-back" below). Same posture the dev tick route takes for
 * the poll, and the wrapper tourReminders.test.ts uses for runDueTourReminders.
 */
const NO_MANUAL_HOLD_BACK: ReadonlySet<ReminderKind> = new Set();
function previewHarness(): ReturnType<typeof makeWebhookHarness> {
  return makeWebhookHarness({ tourReminderManualOnlyKinds: NO_MANUAL_HOLD_BACK });
}

/**
 * The poll with the hold-back switched off - the cases below drive a real send
 * to compare it against the GET preview, and the production default would send
 * nothing. See the twin wrapper in tourReminders.test.ts.
 */
function runDueTourReminders(now: string, deps: RunDueTourRemindersDeps): Promise<void> {
  return runDueTourRemindersRaw(now, { manualOnlyKinds: NO_MANUAL_HOLD_BACK, ...deps });
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

    const { reminders, next, timezone } = res.body as {
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
      timezone?: string;
    };

    // The LIST response carries the zone the bodies were composed in (spec D8):
    // the panel formats its own time labels with it, so a navigator outside the
    // org's zone never reads a chip that contradicts the body beside it.
    expect(timezone).toBe(world.settings.timezone);

    // Sorted ascending by dueAt: confirmation, day_before, morning_of.
    expect(reminders.map((r) => r.kind)).toEqual(['confirmation', 'day_before', 'morning_of']);
    expect(reminders.map((r) => r.state)).toEqual(['sent', 'upcoming', 'canceled']);

    // Bodies are the composed rung text: this tour's instant in the org zone
    // the route composes in, with no address ('unit-states-1' is not seeded)
    // and no names ('contact-states-1' is never pushed onto world.contacts, so
    // the route's tenant read finds nothing and the copy greets "there").
    for (const r of reminders) {
      expect(r.body).toBe(
        composeTourReminderBody({
          kind: r.kind,
          scheduledAt: '2026-07-15T10:00:00.000Z',
          timezone: world.settings.timezone,
          tourType: 'landlord_led',
          names: {},
        }),
      );
      // A non-self_guided tour still gets no RECIPIENT-state estimate (Task 2
      // scope: that preview needs 1:1 routing). Since the 2026-08-20 hold-back
      // its UPCOMING rungs do carry `paused`, which is derived from the kind and
      // needs no recipient IO - a terminal rung carries nothing either way.
      if (r.state === 'upcoming') {
        expect(r.suppression).toEqual({ reason: 'paused' });
      } else {
        expect(r.suppression).toBeUndefined();
      }
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
    const { app, world } = previewHarness();

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
    const { app, world } = previewHarness();
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
    const { app, world } = previewHarness();
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
    const { app, world } = previewHarness();
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
    const { app, world } = previewHarness();
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
    const { app, world } = previewHarness();
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
    const { app, world } = previewHarness();
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

  // Manual-only hold-back (founder decision 2026-08-20). These run on the
  // PRODUCTION default - no previewHarness - because the hold-back is the thing
  // under test.
  describe('manual-only hold-back', () => {
    it('chips an upcoming rung `paused` instead of leaving it to read "sending shortly"', async () => {
      const { app, world } = makeWebhookHarness();
      const tourId = await seedQuietTour(world, 'paused-1', '+15550600021');
      seedReminder(world, {
        reminderId: 'rem-paused-1',
        tourId,
        kind: 'day_before',
        // Already past due: the poll will never claim it, so without `paused`
        // the panel would chip "sending shortly" forever.
        dueAt: isoHoursFromNow(-4),
      });

      const res = await authed(app).get(`/api/tours/${tourId}/reminders`);
      expect(res.status).toBe(200);
      const upcoming = (
        res.body.reminders as { state: string; suppression?: { reason: string } }[]
      ).find((r) => r.state === 'upcoming');
      expect(upcoming?.suppression).toEqual({ reason: 'paused' });
    });

    it('chips a GROUP-routed tour too, where no recipient-state estimate is computed', async () => {
      const { app, world } = makeWebhookHarness();
      // landlord_led: resolveTenantSuppression never runs for this shape, so
      // `paused` is the ONLY estimate the route can produce - and the one that
      // keeps these panels honest.
      const created = await world.toursRepo.create({
        tenantId: 'contact-paused-group',
        unitId: 'unit-paused-group',
        scheduledAt: '2099-01-10T10:00:00.000Z',
        tourType: 'landlord_led',
      });
      seedReminder(world, {
        reminderId: 'rem-paused-group',
        tourId: created.tourId,
        kind: 'en_route',
        dueAt: isoHoursFromNow(-1),
      });

      const res = await authed(app).get(`/api/tours/${created.tourId}/reminders`);
      expect(res.status).toBe(200);
      const upcoming = (
        res.body.reminders as { state: string; suppression?: { reason: string } }[]
      ).find((r) => r.state === 'upcoming');
      expect(upcoming?.suppression).toEqual({ reason: 'paused' });
    });

    it('a HARDER reason still outranks the pause (an opted-out tenant is named, not hidden)', async () => {
      // The pause invites "Send now". A send-now to an opted-out contact is
      // refused, so the operator has to be told the real reason up front rather
      // than being sent into that refusal.
      const { app, world } = makeWebhookHarness();
      const phone = '+15550600022';
      const tourId = await seedQuietTour(world, 'paused-2', phone);
      const tenant = world.contacts.find((c) => c.contactId === 'contact-quiet-paused-2');
      if (tenant !== undefined) tenant.sms_opt_out = true;
      seedReminder(world, {
        reminderId: 'rem-paused-2',
        tourId,
        kind: 'day_before',
        dueAt: isoHoursFromNow(24),
      });

      const res = await authed(app).get(`/api/tours/${tourId}/reminders`);
      expect(res.status).toBe(200);
      const upcoming = (
        res.body.reminders as { state: string; suppression?: { reason: string } }[]
      ).find((r) => r.state === 'upcoming');
      expect(upcoming?.suppression).toEqual({ reason: 'contact_opted_out' });
    });

    it('a terminal rung carries no estimate at all', async () => {
      const { app, world } = makeWebhookHarness();
      const tourId = await seedQuietTour(world, 'paused-3', '+15550600023');
      seedReminder(world, {
        reminderId: 'rem-paused-3',
        tourId,
        kind: 'confirmation',
        dueAt: isoHoursFromNow(-48),
        sentAt: isoHoursFromNow(-47),
      });

      const res = await authed(app).get(`/api/tours/${tourId}/reminders`);
      expect(res.status).toBe(200);
      const sent = (
        res.body.reminders as { state: string; suppression?: { reason: string } }[]
      ).find((r) => r.state === 'sent');
      expect(sent?.suppression).toBeUndefined();
    });
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
    // address ('unit-sendnow-1' is not seeded) and no names (seedSendNowTour's
    // tenant contact carries a phone but no firstName).
    expect(res.body.reminder.body).toBe(
      composeTourReminderBody({
        kind: 'day_before',
        scheduledAt: '2026-07-20T14:00:00.000Z',
        timezone: world.settings.timezone,
        tourType: 'self_guided',
        names: {},
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
    // ANTI-VACUITY: equality alone would still hold if BOTH sides silently lost
    // the address (e.g. unitsRepo dropped from the route deps AND the poll deps)
    // and composed the _no_address variant. Naming the street pins that both
    // sides really took the address-bearing path.
    expect(preview.body).toContain('412 Sender Way NW');
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

    // The OTHER half of the rule: a rung that was never claimed has no sentBody,
    // so it must keep composing LIVE and follow the tour to its new time. Its
    // dueAt sits far past the confirmation's, so the send run below never
    // claims it (and it is not in that release batch, so nothing supersedes it).
    const pendingId = 'rem-composed-history-pending';
    seedReminder(world, {
      reminderId: pendingId,
      tourId,
      kind: 'day_before',
      dueAt: '2099-01-09T10:00:00.000Z',
    });

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

    // ...WHILE the pending sibling renders the NEW details. This is the half
    // that catches a future "just render sentBody whenever it exists" (or
    // "freeze every body at arm time") simplification: history is frozen ONLY
    // for what we actually texted.
    const pendingAfter = afterReschedule.body.reminders.find(
      (r: { reminderId: string }) => r.reminderId === pendingId,
    );
    expect(pendingAfter.state).toBe('upcoming');
    expect(pendingAfter.body).toBe(
      composeTourReminderBody({
        kind: 'day_before',
        scheduledAt: '2026-12-01T20:00:00.000Z',
        timezone: world.settings.timezone,
        tourType: 'self_guided',
        // seedQuietTour's tenant carries no firstName, and seedComposedTour's
        // unit points at a landlordId that is never pushed onto world.contacts
        // - so BOTH names resolve to absence and the copy greets "there".
        names: {},
        // formatStreet projects line1(+line2) only - the street the fixture seeds.
        address: { line1: '412 Sender Way NW' },
      }),
    );
    expect(pendingAfter.body).not.toBe(sentAfter.body);
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

// ===========================================================================
// RESOLVED NAMES (tour-reminder-ladder, spec 6.3/6.3a/6.3b). Every compose
// path now resolves the tenant and the unit's property contact BEFORE it
// composes. These three cases pin the reachable ABSENCE semantics; the FAILURE
// semantics (a throwing read must not send a wrong-but-valid message) are the
// next task's, and case 2 below is written so it survives that change.
// ===========================================================================
describe('resolved names on the tour-reminder compose paths', () => {
  it('the no-show draft greets the tenant by first name', async () => {
    // Spec 9.2: this route used to resolve tour.no_show_checkin DIRECTLY, which
    // 500s the moment the copy carries {tenantFirstName}. It now runs through
    // the ONE composer with the tenant resolved.
    const { app, world } = makeWebhookHarness();
    world.contacts.push({
      contactId: 'contact-draft-named',
      type: 'tenant',
      phone: '+15550720001',
      firstName: 'Alice',
      created_at: '2026-07-13T00:00:00.000Z',
    } as Parameters<typeof world.contacts.push>[0]);
    const created = await world.toursRepo.create({
      tenantId: 'contact-draft-named',
      unitId: 'unit-draft-named',
      scheduledAt: '2026-07-20T14:00:00.000Z',
      tourType: 'self_guided',
    });

    const res = await authed(app).get(
      `/api/tours/${created.tourId}/no-show-checkin-draft`,
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ body: 'Hi Alice! Do you need to reschedule?' });
  });

  it('REGRESSION PIN: a throwing property-contact read still answers the ladder 200', async () => {
    // NOT TDD - expected green on its first run, because resolveTourContactNames
    // never throws by contract. It is a pin on that contract: the ladder is a
    // READ path and must never 500 over a name (spec 6.3b).
    //
    // The fixture is deliberately SELF_GUIDED: no rung of a self_guided tour
    // needs the property contact, so this pin stays green when the next task's
    // withhold rule lands (that task owns the landlord_led side).
    const { app, world } = makeWebhookHarness();
    world.units.set('unit-throwing-contact', {
      unitId: 'unit-throwing-contact',
      landlordId: 'contact-landlord-throws',
      status: 'available',
      address: { line1: '99 Throwing Way NW', city: 'Atlanta', state: 'GA', zip: '30318' },
      created_at: '2026-07-13T00:00:00.000Z',
      updated_at: '2026-07-13T00:00:00.000Z',
    });
    const created = await world.toursRepo.create({
      tenantId: 'contact-throw-tenant',
      unitId: 'unit-throwing-contact',
      scheduledAt: '2026-07-20T14:00:00.000Z',
      tourType: 'self_guided',
    });
    seedReminder(world, {
      reminderId: 'rem-throwing-contact',
      tourId: created.tourId,
      kind: 'day_before',
      dueAt: '2026-07-19T14:00:00.000Z',
    });
    // Only the LANDLORD read throws; the tenant read stays honest so the two
    // failure surfaces cannot be confused for each other.
    const realGetById = world.contactsRepo.getById.bind(world.contactsRepo);
    world.contactsRepo.getById = async (contactId: string) => {
      if (contactId === 'contact-landlord-throws') throw new Error('contacts unavailable');
      return realGetById(contactId);
    };

    const res = await authed(app).get(`/api/tours/${created.tourId}/reminders`);

    expect(res.status).toBe(200);
    const rung = res.body.reminders[0] as { kind: string; body: string };
    expect(rung.kind).toBe('day_before');
    // Absence fallbacks, composed - not blank, not a 500.
    expect(rung.body).toBe(
      composeTourReminderBody({
        kind: 'day_before',
        scheduledAt: '2026-07-20T14:00:00.000Z',
        timezone: world.settings.timezone,
        tourType: 'self_guided',
        names: {},
      }),
    );
  });

  it('the poll SENDS to a tenant contact that exists but carries no name', async () => {
    // Genuine ABSENCE must still send (spec 6.3b) - only FAILURE may hold a
    // rung back, and that is the next task's rule. The greeting degrades to
    // "there" rather than the rung being lost.
    //
    // The fixture is a contact that EXISTS with no firstName, NOT an absent
    // one: an absent tenant never reaches compose on the 1:1 route
    // (resolveReminderTarget claim-skips it 'contact_missing' first, and that
    // is deliberate - spec 6.3b).
    const spy = makeSendSpy();
    const { world } = makeWebhookHarness({ sendMessageService: spy.service });
    const deps = pollDepsFrom(world, spy.service);
    const tourId = await seedQuietTour(world, 'nameless', '+15550720003');
    Object.assign(
      world.contacts.find((c) => c.contactId === 'contact-quiet-nameless')!,
      { consent_method: 'inbound_text' },
    );
    seedReminder(world, {
      reminderId: 'rem-nameless',
      tourId,
      kind: 'day_before',
      dueAt: '2098-12-09T15:00:00.000Z',
    });

    await runDueTourReminders('2098-12-09T15:00:01.000Z', deps);

    expect(spy.sent).toHaveLength(1);
    // toMatch, not a .startsWith() member read: SendMessageInput.body is
    // optional, so the member form is a TS2532 the vitest run cannot see.
    expect(spy.sent[0]!.body).toMatch(/^Hey there, /);
  });
});

// ===========================================================================
// FAILURE IS NOT ABSENCE on the ROUTE surfaces (tour-reminder-ladder, spec
// 6.3b / 6.3a). Two severities, one catalog-derived assessor:
//   - blocksSend    -> send-now answers 409 names_unavailable; the no-show
//                      DRAFT (the head of a hand send) answers the same.
//   - withholdPreview -> the preview renders body: '' where the failed read
//                      would change WHICH ENTRY composes, and ONLY there. A
//                      merely blanked token DEGRADES to "Hey there," instead.
// ===========================================================================
describe('name-read FAILURE on the tour-reminder route surfaces (spec 6.3b)', () => {
  /**
   * THE SHARED ROUTE FIXTURE: a `landlord_led` tour with NO groupThreadId (so
   * the rungs fall back to the tenant 1:1, which exists with consent) whose
   * unit names a property contact whose read THROWS. Only that one id throws -
   * the tenant read stays honest so the two failure surfaces can never be
   * confused for one another.
   */
  async function seedThrowingPropertyTour(
    world: FakeWorld,
    suffix: string,
    phone: string,
  ): Promise<{ tourId: string; tenantId: string; landlordId: string }> {
    const tenantId = `contact-nf-${suffix}`;
    const unitId = `unit-nf-${suffix}`;
    const landlordId = `c-boom-${suffix}`;
    world.contacts.push({
      contactId: tenantId,
      type: 'tenant',
      phone,
      consent_method: 'inbound_text',
      created_at: '2026-07-13T00:00:00.000Z',
    } as Parameters<typeof world.contacts.push>[0]);
    world.conversations.set(`conv-nf-${suffix}`, {
      conversationId: `conv-nf-${suffix}`,
      participant_phone: phone,
      status: 'open',
      type: 'tenant_1to1',
      ai_mode: 'auto',
      last_activity_at: '2026-07-13T00:00:00.000Z',
      created_at: '2026-07-13T00:00:00.000Z',
    });
    world.units.set(unitId, {
      unitId,
      landlordId,
      status: 'available',
      created_at: '2026-07-13T00:00:00.000Z',
      updated_at: '2026-07-13T00:00:00.000Z',
    });
    const created = await world.toursRepo.create({
      tenantId,
      unitId,
      scheduledAt: '2099-01-10T10:00:00.000Z',
      tourType: 'landlord_led',
    });
    const realGetById = world.contactsRepo.getById.bind(world.contactsRepo);
    world.contactsRepo.getById = async (contactId: string) => {
      if (contactId === landlordId) throw new Error('contacts unavailable');
      return realGetById(contactId);
    };
    return { tourId: created.tourId, tenantId, landlordId };
  }

  it('case 4: send-now answers 409 names_unavailable and leaves the rung upcoming', async () => {
    const spy = makeSendSpy();
    const { app, world } = makeWebhookHarness({ sendMessageService: spy.service });
    const { tourId } = await seedThrowingPropertyTour(world, 'sendnow', '+15550740001');
    seedReminder(world, {
      reminderId: 'rem-nf-sendnow',
      tourId,
      kind: 'en_route',
      dueAt: '2099-01-10T09:00:00.000Z',
    });

    const res = await authed(app).post(`/api/tours/${tourId}/reminders/rem-nf-sendnow/send-now`);

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('names_unavailable');
    expect(res.body.reminder.state).toBe('upcoming');
    expect(spy.sent).toHaveLength(0);
    expect(world.tourRemindersMap.get('rem-nf-sendnow')?.sentAt).toBeUndefined();
    expect(world.tourRemindersMap.get('rem-nf-sendnow')?.skippedAt).toBeUndefined();
  });

  it('case 5: the GET ladder WITHHOLDS only the en_route body - day_before composes normally', async () => {
    // Spec 6.3a "never a different ENTRY": the en_route rung of a landlord-led
    // tour is the one place a failed property read would flip WHICH entry
    // composes, so its preview is withheld. day_before's copy never touches
    // that read, so blanking it would be a self-inflicted outage.
    const { app, world } = makeWebhookHarness();
    const { tourId } = await seedThrowingPropertyTour(world, 'preview', '+15550740002');
    seedReminder(world, {
      reminderId: 'rem-nf-enroute',
      tourId,
      kind: 'en_route',
      dueAt: '2099-01-10T09:00:00.000Z',
    });
    seedReminder(world, {
      reminderId: 'rem-nf-daybefore',
      tourId,
      kind: 'day_before',
      dueAt: '2099-01-09T10:00:00.000Z',
    });

    const res = await authed(app).get(`/api/tours/${tourId}/reminders`);

    expect(res.status).toBe(200);
    const rungs = res.body.reminders as Array<{ reminderId: string; body: string }>;
    expect(rungs.find((r) => r.reminderId === 'rem-nf-enroute')!.body).toBe('');
    expect(rungs.find((r) => r.reminderId === 'rem-nf-daybefore')!.body).toBe(
      composeTourReminderBody({
        kind: 'day_before',
        scheduledAt: '2099-01-10T10:00:00.000Z',
        timezone: world.settings.timezone,
        tourType: 'landlord_led',
        names: {},
      }),
    );
  });

  it('case 9: the no-show DRAFT refuses with 409 names_unavailable when the tenant read throws', async () => {
    // THE FIFTH CONSUMER, and the one Phase A actually uses. A
    // failure-masquerading "Hi there!" prefill would be hand-sent to a real
    // tenant - the exact wrong-but-valid message 6.3b forbids.
    const { app, world } = makeWebhookHarness();
    world.contacts.push({
      contactId: 'contact-draft-boom',
      type: 'tenant',
      phone: '+15550740003',
      created_at: '2026-07-13T00:00:00.000Z',
    } as Parameters<typeof world.contacts.push>[0]);
    const created = await world.toursRepo.create({
      tenantId: 'contact-draft-boom',
      unitId: 'unit-draft-boom',
      scheduledAt: '2026-07-20T14:00:00.000Z',
      tourType: 'self_guided',
    });
    const realGetById = world.contactsRepo.getById.bind(world.contactsRepo);
    world.contactsRepo.getById = async (contactId: string) => {
      if (contactId === 'contact-draft-boom') throw new Error('contacts unavailable');
      return realGetById(contactId);
    };

    const res = await authed(app).get(`/api/tours/${created.tourId}/no-show-checkin-draft`);

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'names_unavailable' });
  });

  it('case 10: the PANEL survives a tenant-read failure - 200, degraded bodies, every rung still `paused`', async () => {
    // Two findings in one case. (1) The GET route's OTHER tenant read
    // (resolveTenantSuppression) is bare, so a rejection 500s the whole ladder.
    // (2) Containing it must NOT hand back a defined-but-empty evaluator: the
    // chip ternary reaches its no-IO `paused` fallback only while suppressionOf
    // is UNDEFINED, so an empty evaluator would flip every chip from "Paused"
    // to the amber "sends in Nh" promise mid-outage - the perpetual-"sending
    // shortly" lie the 2026-08-20 pause chip exists to end.
    //
    // Plain makeWebhookHarness(), NOT previewHarness(): the latter injects the
    // EMPTY manual-only set, which would make `paused` false and the assertion
    // below unmeetable.
    const { app, world } = makeWebhookHarness();
    world.contacts.push({
      contactId: 'contact-panel-boom',
      type: 'tenant',
      phone: '+15550740004',
      created_at: '2026-07-13T00:00:00.000Z',
    } as Parameters<typeof world.contacts.push>[0]);
    const created = await world.toursRepo.create({
      tenantId: 'contact-panel-boom',
      unitId: 'unit-panel-boom',
      scheduledAt: '2099-01-10T10:00:00.000Z',
      tourType: 'self_guided',
    });
    for (const [reminderId, kind, dueAt] of [
      ['rem-panel-conf', 'confirmation', '2099-01-05T10:00:00.000Z'],
      ['rem-panel-day', 'day_before', '2099-01-09T10:00:00.000Z'],
      ['rem-panel-morn', 'morning_of', '2099-01-10T06:00:00.000Z'],
      ['rem-panel-route', 'en_route', '2099-01-10T09:00:00.000Z'],
    ] as Array<[string, ReminderKind, string]>) {
      seedReminder(world, { reminderId, tourId: created.tourId, kind, dueAt });
    }
    const realGetById = world.contactsRepo.getById.bind(world.contactsRepo);
    world.contactsRepo.getById = async (contactId: string) => {
      if (contactId === 'contact-panel-boom') throw new Error('contacts unavailable');
      return realGetById(contactId);
    };

    const res = await authed(app).get(`/api/tours/${created.tourId}/reminders`);

    expect(res.status).toBe(200);
    const rungs = res.body.reminders as Array<{
      reminderId: string;
      kind: string;
      state: string;
      body: string;
      suppression?: { reason: string };
    }>;
    expect(rungs).toHaveLength(4);
    // A tenant-read blip must NOT blank the ladder: every rung degrades to the
    // absence fallbacks instead.
    expect(rungs.every((r) => r.body !== '')).toBe(true);
    for (const kind of ['day_before', 'morning_of', 'en_route']) {
      expect(rungs.find((r) => r.kind === kind)!.body).toMatch(/^Hey there, /);
    }
    expect(rungs.find((r) => r.kind === 'confirmation')!.body).toContain('your tour is set for');
    // THE PAUSED HALF IS THE POINT - and it must be the paused reason, not
    // merely "some suppression" and not "no suppression".
    for (const rung of rungs) {
      expect(rung.state).toBe('upcoming');
      expect(rung.suppression).toEqual({ reason: 'paused' });
    }
  });

  it('pin 8: two landlord-led tours on DIFFERENT units each render their OWN landlord in en_route', async () => {
    // Expected GREEN on first run (Task 4 wired it) - a drift pin on the
    // per-tour resolve, so a future "one resolve per request" optimization
    // cannot stamp one person's name onto another property's ladder.
    const { app, world } = makeWebhookHarness();
    for (const [unitId, contactId, firstName] of [
      ['unit-pin8-a', 'c-pin8-dana', 'Dana'],
      ['unit-pin8-b', 'c-pin8-lee', 'Lee'],
    ]) {
      world.units.set(unitId!, {
        unitId: unitId!,
        landlordId: contactId!,
        status: 'available',
        created_at: '2026-07-13T00:00:00.000Z',
        updated_at: '2026-07-13T00:00:00.000Z',
      });
      world.contacts.push({
        contactId: contactId!,
        type: 'landlord',
        phone: '+1555074900' + (firstName === 'Dana' ? '1' : '2'),
        firstName: firstName!,
        created_at: '2026-07-13T00:00:00.000Z',
      } as Parameters<typeof world.contacts.push>[0]);
    }
    const bodies: string[] = [];
    for (const [suffix, unitId] of [
      ['a', 'unit-pin8-a'],
      ['b', 'unit-pin8-b'],
    ]) {
      const created = await world.toursRepo.create({
        tenantId: 'contact-pin8-tenant',
        unitId: unitId!,
        scheduledAt: '2099-01-10T10:00:00.000Z',
        tourType: 'landlord_led',
      });
      seedReminder(world, {
        reminderId: `rem-pin8-${suffix}`,
        tourId: created.tourId,
        kind: 'en_route',
        dueAt: '2099-01-10T09:00:00.000Z',
      });
      const res = await authed(app).get(`/api/tours/${created.tourId}/reminders`);
      expect(res.status).toBe(200);
      bodies.push((res.body.reminders as Array<{ body: string }>)[0]!.body);
    }
    expect(bodies[0]).toContain('Dana will be headed');
    expect(bodies[1]).toContain('Lee will be headed');
  });
});
