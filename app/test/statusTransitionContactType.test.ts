// transitionPlacement - a placement leaving a terminal stage needs a tenant
// (caseworker integrity spec 2026-10-12, section 4, I2). Moving a placement
// out of `moved_in` / `lost` into a non-terminal stage re-opens it, so the
// SERVICE reads its tenant CONSISTENTLY first and refuses - before any write -
// with ContactNotTenantError (carrying contactKind) or TenantNotFoundError.
// Moves between non-terminal stages, into a terminal stage, or between the two
// terminal stages are not checked. World fakes (no DynamoDB).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createLogger } from '../src/lib/logger.js';
import type { PlacementStage } from '../src/lib/statusModel.js';
import type { ContactItem } from '../src/repos/contactsRepo.js';
import { ContactNotTenantError, TenantNotFoundError } from '../src/services/contactTypeGuards.js';
import {
  createStatusTransitionService,
  type StatusTransitionService,
} from '../src/services/statusTransition.js';
import { createLogCapture } from './helpers/logCapture.js';
import { createFakeWorld, type FakeWorld } from './helpers/twilioWebhookHarness.js';

const SUBJECT = 'c-subject';
const UNIT = 'unit-1';

let world: FakeWorld;
let svc: StatusTransitionService;

beforeEach(async () => {
  world = createFakeWorld();
  svc = createStatusTransitionService({
    placementsRepo: world.placementsRepo,
    placementDeadlinesRepo: world.placementDeadlinesRepo,
    unitsRepo: world.unitsRepo,
    contactsRepo: world.contactsRepo,
    auditRepo: world.auditRepo,
    events: world.events,
    logger: createLogger({ destination: createLogCapture().stream }),
  });
  await world.unitsRepo.create({ unitId: UNIT, landlordId: 'll-1', status: 'available' });
});

function seedContact(fields: Partial<ContactItem>): void {
  world.contacts.push({ contactId: SUBJECT, type: 'tenant', ...fields } as ContactItem);
}

async function seedPlacement(stage: PlacementStage): Promise<string> {
  const placement = await world.placementsRepo.create({ tenantId: SUBJECT, unitId: UNIT, stage });
  return placement.placementId;
}

function stageChangedRows(): unknown[] {
  return world.auditEvents.filter((a) => a.event_type === 'placement_stage_changed');
}

const EXITS = [
  ['lost', 'send_application'],
  ['lost', 'awaiting_inspection'],
  ['moved_in', 'awaiting_move_in'],
] as const;

describe('transitionPlacement - leaving a terminal stage needs a tenant (I2)', () => {
  it.each(EXITS)('%s -> %s for a landlord: ContactNotTenantError, nothing written', async (from, to) => {
    seedContact({ type: 'landlord' });
    const id = await seedPlacement(from);

    const err = await svc.transitionPlacement(id, { toStage: to, source: 'manual' }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ContactNotTenantError);
    expect((err as ContactNotTenantError).contactKind).toBe('landlord');
    expect(world.placements.get(id)!.stage).toBe(from);
    expect(stageChangedRows()).toEqual([]);
  });

  it('a caseworker is refused with contactKind caseworker', async () => {
    seedContact({ type: 'partner', role: 'Caseworker' });
    const id = await seedPlacement('lost');

    const err = await svc
      .transitionPlacement(id, { toStage: 'send_application', source: 'manual' })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ContactNotTenantError);
    expect((err as ContactNotTenantError).contactKind).toBe('caseworker');
    expect(world.placements.get(id)!.stage).toBe('lost');
  });

  it('a missing tenant throws TenantNotFoundError and writes nothing', async () => {
    const id = await seedPlacement('moved_in');

    await expect(
      svc.transitionPlacement(id, { toStage: 'awaiting_move_in', source: 'manual' }),
    ).rejects.toBeInstanceOf(TenantNotFoundError);
    expect(world.placements.get(id)!.stage).toBe('moved_in');
    expect(stageChangedRows()).toEqual([]);
  });

  it('a tenant may leave lost - the tenant is read CONSISTENTLY', async () => {
    seedContact({ type: 'tenant' });
    const id = await seedPlacement('lost');
    const getById = vi.spyOn(world.contactsRepo, 'getById');

    const updated = await svc.transitionPlacement(id, { toStage: 'send_application', source: 'manual' });

    expect(updated.stage).toBe('send_application');
    expect(getById).toHaveBeenCalledWith(SUBJECT, { consistentRead: true });
  });
});

describe('transitionPlacement - moves the terminal-exit check does NOT cover', () => {
  it('(PIN) between non-terminal stages: a landlord placement still moves', async () => {
    seedContact({ type: 'landlord' });
    const id = await seedPlacement('send_application');

    const updated = await svc.transitionPlacement(id, { toStage: 'awaiting_approval', source: 'manual' });

    expect(updated.stage).toBe('awaiting_approval');
  });

  it('(PIN) into a terminal stage: a landlord placement can still be marked lost', async () => {
    seedContact({ type: 'landlord' });
    const id = await seedPlacement('collect_rta');

    const updated = await svc.transitionPlacement(id, { toStage: 'lost', source: 'manual' });

    expect(updated.stage).toBe('lost');
  });

  it('(PIN) between the two terminal stages: lost -> moved_in is not checked', async () => {
    seedContact({ type: 'landlord' });
    const id = await seedPlacement('lost');

    const updated = await svc.transitionPlacement(id, { toStage: 'moved_in', source: 'manual' });

    expect(updated.stage).toBe('moved_in');
  });
});
