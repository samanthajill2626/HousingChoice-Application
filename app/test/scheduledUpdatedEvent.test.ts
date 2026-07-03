// scheduled.updated SSE event (scheduled-message-visibility, Task 6).
//
// A single new bus event, emitted when a reminder/nudge ladder is armed,
// rescheduled, or canceled, so a contact timeline's pinned "Upcoming" section
// updates live. Payload is IDs only (no PII).
//
//   - Tour create (with a time)  → scheduled.updated { contactId: tenantId }
//   - Tour reschedule (PATCH)    → scheduled.updated { contactId: tenantId }
//   - Tour cancel                → scheduled.updated { contactId: tenantId }
//   - armNudgeForStage (arm)     → scheduled.updated { contactId: placement.tenantId }
//   - armNudgeForStage (cancel-only, rung-less stage) → still emits (ladder changed)
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createEventBus, type ScheduledUpdatedEvent } from '../src/lib/events.js';
import { armNudgeForStage } from '../src/jobs/placementNudges.js';
import type {
  PlacementNudgeItem,
  PlacementNudgesRepo,
} from '../src/repos/placementNudgesRepo.js';
import type { PlacementItem } from '../src/repos/placementsRepo.js';
import type { PlacementStage } from '../src/lib/statusModel.js';
import { TEST_SESSION_COOKIE } from './helpers/authSession.js';
import { makeWebhookHarness, ORIGIN_SECRET } from './helpers/twilioWebhookHarness.js';

const SECRET = ORIGIN_SECRET;

function authed(app: ReturnType<typeof makeWebhookHarness>['app']) {
  return {
    post: (path: string) =>
      request(app).post(path).set('x-origin-verify', SECRET).set('cookie', TEST_SESSION_COOKIE),
    patch: (path: string) =>
      request(app).patch(path).set('x-origin-verify', SECRET).set('cookie', TEST_SESSION_COOKIE),
  };
}

const BASE_CREATE_BODY = {
  tenantId: 'contact-tenant-1',
  unitId: 'unit-abc',
  scheduledAt: '2026-07-15T10:00:00.000Z',
  tourType: 'self_guided',
};

function scheduledEmits(world: ReturnType<typeof makeWebhookHarness>['world']): ScheduledUpdatedEvent[] {
  return world.emitted
    .filter((e) => e.event === 'scheduled.updated')
    .map((e) => e.payload as ScheduledUpdatedEvent);
}

// ---------------------------------------------------------------------------
// Tours — arm / reschedule / cancel emit scheduled.updated
// ---------------------------------------------------------------------------

describe('scheduled.updated — tours', () => {
  it('emits { contactId: tenantId } when a tour is booked with a time', async () => {
    const { app, world } = makeWebhookHarness();
    const res = await authed(app).post('/api/tours').send(BASE_CREATE_BODY);
    expect(res.status).toBe(201);

    const emits = scheduledEmits(world);
    expect(emits).toContainEqual({ contactId: 'contact-tenant-1' });
  });

  it('does NOT emit on a timeless (requested) create', async () => {
    const { app, world } = makeWebhookHarness();
    const res = await authed(app)
      .post('/api/tours')
      .send({ tenantId: 'contact-tenant-1', unitId: 'unit-abc', tourType: 'self_guided' });
    expect(res.status).toBe(201);
    expect(scheduledEmits(world)).toHaveLength(0);
  });

  it('emits on reschedule (PATCH scheduledAt)', async () => {
    const { app, world } = makeWebhookHarness();
    const created = await authed(app).post('/api/tours').send(BASE_CREATE_BODY);
    const tourId = created.body.tour.tourId as string;

    // Reset the recorded emits to isolate the reschedule.
    world.emitted.length = 0;
    const res = await authed(app)
      .patch(`/api/tours/${tourId}`)
      .send({ scheduledAt: '2026-07-20T14:00:00.000Z' });
    expect(res.status).toBe(200);

    expect(scheduledEmits(world)).toContainEqual({ contactId: 'contact-tenant-1' });
  });

  it('emits on cancel (PATCH status=canceled)', async () => {
    const { app, world } = makeWebhookHarness();
    const created = await authed(app).post('/api/tours').send(BASE_CREATE_BODY);
    const tourId = created.body.tour.tourId as string;

    world.emitted.length = 0;
    const res = await authed(app).patch(`/api/tours/${tourId}`).send({ status: 'canceled' });
    expect(res.status).toBe(200);

    expect(scheduledEmits(world)).toContainEqual({ contactId: 'contact-tenant-1' });
  });
});

// ---------------------------------------------------------------------------
// Nudges — armNudgeForStage emits scheduled.updated best-effort
// ---------------------------------------------------------------------------

function makeFakeNudgesRepo(): PlacementNudgesRepo {
  const rows: PlacementNudgeItem[] = [];
  let counter = 0;
  return {
    async create(input: { placementId: string; kind: PlacementNudgeItem['kind']; dueAt: string }) {
      const row: PlacementNudgeItem = {
        nudgeId: `nudge-${++counter}`,
        placementId: input.placementId,
        kind: input.kind,
        dueAt: input.dueAt,
        _nudgePartition: 'nudges',
        createdAt: '2026-07-03T00:00:00.000Z',
      };
      rows.push(row);
      return row;
    },
    async cancelForPlacement(placementId: string) {
      for (const r of rows) {
        if (r.placementId === placementId && r.sentAt === undefined && r.canceledAt === undefined) {
          r.canceledAt = '2026-07-03T00:00:00.000Z';
        }
      }
    },
  } as unknown as PlacementNudgesRepo;
}

function makePlacement(stage: PlacementStage, tenantId: string): PlacementItem {
  return { placementId: 'p-1', tenantId, unitId: 'unit-1', stage } as PlacementItem;
}

describe('scheduled.updated — nudges', () => {
  const NOW = '2026-07-03T10:00:00.000Z';

  it('emits { contactId: placement.tenantId } when a nudge-arming stage is entered', async () => {
    const events = createEventBus();
    const emitted: ScheduledUpdatedEvent[] = [];
    events.on('scheduled.updated', (p) => emitted.push(p));

    const placement = makePlacement('awaiting_receipt', 'contact-tenant-9');
    await armNudgeForStage(placement, 'awaiting_receipt', NOW, {
      placementNudgesRepo: makeFakeNudgesRepo(),
      events,
    });

    expect(emitted).toContainEqual({ contactId: 'contact-tenant-9' });
  });

  it('emits on a rung-less (cancel-only) stage too — the ladder still changed', async () => {
    const events = createEventBus();
    const emitted: ScheduledUpdatedEvent[] = [];
    events.on('scheduled.updated', (p) => emitted.push(p));

    const placement = makePlacement('lost', 'contact-tenant-9');
    await armNudgeForStage(placement, 'lost', NOW, {
      placementNudgesRepo: makeFakeNudgesRepo(),
      events,
    });

    expect(emitted).toContainEqual({ contactId: 'contact-tenant-9' });
  });

  it('never throws when no events dep is supplied', async () => {
    const placement = makePlacement('awaiting_receipt', 'contact-tenant-9');
    await expect(
      armNudgeForStage(placement, 'awaiting_receipt', NOW, {
        placementNudgesRepo: makeFakeNudgesRepo(),
      }),
    ).resolves.toBeUndefined();
  });
});
