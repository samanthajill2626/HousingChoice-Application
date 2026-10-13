// deriveTenantStatus skips a contact that is not typed tenant (caseworker
// integrity spec 2026-10-12, section 4 "Derived tenant status"; plan watch
// item W5). A placement move derives the TENANT lifecycle only for a contact
// typed `tenant`: for anyone else nothing is written - no status, no audit
// row, no timeline milestone - and one info line says why. The PROPERTY's
// derived listing status is unchanged by this rule. Service on world fakes.
import { beforeEach, describe, expect, it } from 'vitest';
import { createLogger } from '../src/lib/logger.js';
import type { ContactItem } from '../src/repos/contactsRepo.js';
import {
  createStatusTransitionService,
  type StatusTransitionService,
} from '../src/services/statusTransition.js';
import { createLogCapture, type LogCapture } from './helpers/logCapture.js';
import { createFakeWorld, type FakeWorld } from './helpers/twilioWebhookHarness.js';

const SKIP_MSG = 'derivation: contact is not a tenant - tenant status left unchanged';
const SUBJECT = 'c-subject';
const UNIT = 'unit-1';

let world: FakeWorld;
let capture: LogCapture;
let svc: StatusTransitionService;

beforeEach(async () => {
  world = createFakeWorld();
  capture = createLogCapture();
  svc = createStatusTransitionService({
    placementsRepo: world.placementsRepo,
    placementDeadlinesRepo: world.placementDeadlinesRepo,
    unitsRepo: world.unitsRepo,
    contactsRepo: world.contactsRepo,
    auditRepo: world.auditRepo,
    activityEventsRepo: world.activityEventsRepo,
    events: world.events,
    logger: createLogger({ level: 'info', destination: capture.stream }),
  });
  await world.unitsRepo.create({ unitId: UNIT, landlordId: 'll-1', status: 'available' });
});

function seedContact(fields: Partial<ContactItem>): void {
  world.contacts.push({ contactId: SUBJECT, type: 'tenant', ...fields } as ContactItem);
}

function storedContact(): ContactItem {
  return world.contacts.find((c) => c.contactId === SUBJECT)!;
}

/** Nothing tenant-side was written for SUBJECT. */
function expectNoTenantWrite(status: string): void {
  expect(storedContact().status).toBe(status);
  expect(storedContact().status_source).toBeUndefined();
  expect(world.auditEvents.filter((a) => a.entityKey === `contacts#${SUBJECT}`)).toEqual([]);
  expect(world.activityEvents.filter((e) => e.type === 'contact_status_changed')).toEqual([]);
}

function skipLines(): Record<string, unknown>[] {
  return capture.lines.filter((l) => l['msg'] === SKIP_MSG);
}

describe('deriveTenantStatus - only a tenant gets a derived tenant status', () => {
  it('a landlord placement moving between active stages: contact untouched, property still derived', async () => {
    seedContact({ type: 'landlord', status: 'interested' });
    const placement = await world.placementsRepo.create({
      tenantId: SUBJECT,
      unitId: UNIT,
      stage: 'send_application',
    });

    await svc.transitionPlacement(placement.placementId, { toStage: 'awaiting_approval', source: 'manual' });

    expectNoTenantWrite('interested');
    // W5: the listing-status derivation is unchanged.
    expect((await world.unitsRepo.getById(UNIT))!.status).toBe('under_application');
    expect(skipLines()).toHaveLength(1);
    expect(skipLines()[0]).toMatchObject({ level: 30, tenantId: SUBJECT, contactType: 'landlord' });
  });

  it('a caseworker (partner + Caseworker role) is skipped too', async () => {
    seedContact({ type: 'partner', role: 'Caseworker', status: 'active' });
    const placement = await world.placementsRepo.create({
      tenantId: SUBJECT,
      unitId: UNIT,
      stage: 'send_application',
    });

    await svc.transitionPlacement(placement.placementId, { toStage: 'collect_rta', source: 'manual' });

    expectNoTenantWrite('active');
    expect(skipLines()).toHaveLength(1);
  });

  it('derive-on-create (deriveForStage) skips a team member; the property is still derived', async () => {
    seedContact({ type: 'team_member', status: 'active' });

    await svc.deriveForStage(SUBJECT, UNIT, 'send_application');

    expectNoTenantWrite('active');
    expect((await world.unitsRepo.getById(UNIT))!.status).toBe('under_application');
    expect(skipLines()).toHaveLength(1);
  });

  it('the lost bounce skips the tenant side for a landlord and still frees the property', async () => {
    seedContact({ type: 'landlord', status: 'interested' });
    await world.unitsRepo.create({ unitId: 'unit-2', landlordId: 'll-1', status: 'under_application' });
    const placement = await world.placementsRepo.create({
      tenantId: SUBJECT,
      unitId: 'unit-2',
      stage: 'collect_rta',
    });

    await svc.transitionPlacement(placement.placementId, { toStage: 'lost', source: 'manual' });

    expectNoTenantWrite('interested');
    expect((await world.unitsRepo.getById('unit-2'))!.status).toBe('available');
  });

  it('(PIN) a tenant still derives: placing, with its audit row and no skip line', async () => {
    seedContact({ type: 'tenant', status: 'searching' });
    const placement = await world.placementsRepo.create({
      tenantId: SUBJECT,
      unitId: UNIT,
      stage: 'send_application',
    });

    await svc.transitionPlacement(placement.placementId, { toStage: 'awaiting_approval', source: 'manual' });

    expect(storedContact().status).toBe('placing');
    expect(world.auditEvents.filter((a) => a.event_type === 'tenant_status_changed')).toHaveLength(1);
    expect(skipLines()).toEqual([]);
  });
});
