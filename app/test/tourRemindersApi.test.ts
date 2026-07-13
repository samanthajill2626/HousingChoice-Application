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
import { resolveMessage } from '../src/messages/index.js';
import { TEST_SESSION_COOKIE } from './helpers/authSession.js';
import { makeWebhookHarness, ORIGIN_SECRET, type FakeWorld } from './helpers/twilioWebhookHarness.js';

const SECRET = ORIGIN_SECRET;

function authed(app: ReturnType<typeof makeWebhookHarness>['app']) {
  return {
    get: (path: string) =>
      request(app).get(path).set('x-origin-verify', SECRET).set('cookie', TEST_SESSION_COOKIE),
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

    // Bodies are the canned rung text.
    for (const r of reminders) {
      expect(r.body).toBe(resolveMessage(`tour.${r.kind}`));
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

  it('returns 404 for an unknown tour id', async () => {
    const { app } = makeWebhookHarness();
    const res = await authed(app).get('/api/tours/no-such-tour/reminders');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'tour_not_found' });
  });
});
