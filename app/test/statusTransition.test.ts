// Unit tests for THE one transition service (services/statusTransition.ts),
// driven on the in-memory fakes (no DynamoDB). Covers: stage stamping +
// provenance audit; §7 derivation; §8 source precedence (derived never
// overwrites a manual pin; manual overwrites derived); tenant-status writes
// (the RTA-in-hand gate was REMOVED 2026-06-19 — → searching always applies);
// porting as a tenant flag (never a stage); final_rent on rent acceptance; Lost
// from any stage (structured reason + the bounce-back guard); and the deadline
// items the transition arms/retires (rta_window on entering/leaving
// awaiting_landlord_submission; clearForPlacement on terminal). The stuck signal
// is DERIVED in today.ts now — the transition arms NO stuck deadline.
import { beforeEach, describe, expect, it } from 'vitest';
import { createFakeWorld, type FakeWorld } from './helpers/twilioWebhookHarness.js';
import { createLogger } from '../src/lib/logger.js';
import { createLogCapture } from './helpers/logCapture.js';
import {
  createStatusTransitionService,
  EntityNotFoundError,
  TransitionRefusedError,
  type StatusTransitionDeps,
  type StatusTransitionService,
} from '../src/services/statusTransition.js';
import { soonestDeadline } from '../src/repos/placementDeadlinesRepo.js';
import type { PlacementItem } from '../src/repos/placementsRepo.js';

/** The soonest deadline's type on a placement (or undefined when none), via the fake repo. */
async function deadlineTypeOf(world: FakeWorld, placementId: string): Promise<string | undefined> {
  const rows = await world.placementDeadlinesRepo.listByPlacement(placementId);
  return soonestDeadline(rows)?.type;
}

function makeService(world: FakeWorld): StatusTransitionService {
  return createStatusTransitionService({
    placementsRepo: world.placementsRepo,
    placementDeadlinesRepo: world.placementDeadlinesRepo,
    unitsRepo: world.unitsRepo,
    contactsRepo: world.contactsRepo,
    auditRepo: world.auditRepo,
    events: world.events,
    logger: createLogger({ destination: createLogCapture().stream }),
  });
}

/** Build the service with optional choke-point hooks (Post-Tour & Application). */
function makeServiceWith(
  world: FakeWorld,
  hooks: Pick<StatusTransitionDeps, 'armStageNudge' | 'closeRelayForLostPlacement'>,
): StatusTransitionService {
  return createStatusTransitionService({
    placementsRepo: world.placementsRepo,
    placementDeadlinesRepo: world.placementDeadlinesRepo,
    unitsRepo: world.unitsRepo,
    contactsRepo: world.contactsRepo,
    auditRepo: world.auditRepo,
    events: world.events,
    logger: createLogger({ destination: createLogCapture().stream }),
    ...hooks,
  });
}

describe('statusTransition — placement stage moves', () => {
  let world: FakeWorld;
  let svc: StatusTransitionService;

  beforeEach(async () => {
    world = createFakeWorld();
    svc = makeService(world);
    await world.contactsRepo.create({ contactId: 'tenant-1', type: 'tenant' });
    await world.unitsRepo.create({ unitId: 'unit-1', landlordId: 'll-1', status: 'available' });
  });

  it('stamps stage + stage_entered_at + stage_source and writes a {actor,from,to,source} audit', async () => {
    const c = await world.placementsRepo.create({ tenantId: 'tenant-1', unitId: 'unit-1', stage: 'send_application' });
    const updated = await svc.transitionPlacement(c.placementId, { toStage: 'collect_rta', source: 'manual', actor: 'usr_va' });
    expect(updated.stage).toBe('collect_rta');
    expect(typeof updated.stage_entered_at).toBe('string');
    expect(updated.stage_source).toBe('manual');

    const audit = world.auditEvents.find((a) => a.event_type === 'placement_stage_changed');
    expect(audit).toBeDefined();
    // The actor (userId) is carried so the byActor GSI indexes status changes (§8).
    expect(audit!.payload).toMatchObject({ actor: 'usr_va', from: 'send_application', to: 'collect_rta', source: 'manual' });
    expect(audit!.entityKey).toBe(`placements#${c.placementId}`);
  });

  it('404s an unknown placement and rejects a bad stage', async () => {
    await expect(svc.transitionPlacement('placement-ghost', { toStage: 'collect_rta', source: 'manual' })).rejects.toBeInstanceOf(EntityNotFoundError);
    const c = await world.placementsRepo.create({ tenantId: 'tenant-1', unitId: 'unit-1', stage: 'send_application' });
    // @ts-expect-error — exercising the runtime guard with a junk stage.
    await expect(svc.transitionPlacement(c.placementId, { toStage: 'bogus', source: 'manual' })).rejects.toBeInstanceOf(TransitionRefusedError);
  });
});

describe('statusTransition — derivation (§7)', () => {
  let world: FakeWorld;
  let svc: StatusTransitionService;

  beforeEach(async () => {
    world = createFakeWorld();
    svc = makeService(world);
    await world.contactsRepo.create({ contactId: 'tenant-1', type: 'tenant' });
    await world.unitsRepo.create({ unitId: 'unit-1', landlordId: 'll-1', status: 'available' });
  });

  const seed = () => world.placementsRepo.create({ tenantId: 'tenant-1', unitId: 'unit-1', stage: 'send_application' });

  it('Application phase ⇒ tenant placing / listing under_application', async () => {
    const c = await seed();
    await svc.transitionPlacement(c.placementId, { toStage: 'awaiting_approval', source: 'manual' });
    expect((await world.contactsRepo.getById('tenant-1'))!.status).toBe('placing');
    expect((await world.unitsRepo.getById('unit-1'))!.status).toBe('under_application');
  });

  it('Contract phase ⇒ listing finalizing (tenant still placing)', async () => {
    const c = await seed();
    await svc.transitionPlacement(c.placementId, { toStage: 'awaiting_hap_contract', source: 'manual' });
    expect((await world.contactsRepo.getById('tenant-1'))!.status).toBe('placing');
    expect((await world.unitsRepo.getById('unit-1'))!.status).toBe('finalizing');
  });

  it('moved_in ⇒ tenant placed / listing occupied', async () => {
    const c = await seed();
    await svc.transitionPlacement(c.placementId, { toStage: 'moved_in', source: 'manual' });
    expect((await world.contactsRepo.getById('tenant-1'))!.status).toBe('placed');
    expect((await world.unitsRepo.getById('unit-1'))!.status).toBe('occupied');
  });
});

// Derivation gating is STATE-based (2026-06-19 decision,
// docs/issues/status-pin-vs-terminal-derivation.md): only OVERRIDE/exit states
// pin against derivation; BASELINE progression states stay derivation-eligible
// regardless of who last wrote them. Explicit writes always apply.
describe('statusTransition — state-based derivation gating (2026-06-19 decision)', () => {
  let world: FakeWorld;
  let svc: StatusTransitionService;

  beforeEach(async () => {
    world = createFakeWorld();
    svc = makeService(world);
    await world.contactsRepo.create({ contactId: 'tenant-1', type: 'tenant' });
    await world.unitsRepo.create({ unitId: 'unit-1', landlordId: 'll-1', status: 'available' });
  });

  it('derivation OVERWRITES a manually-set BASELINE listing status (the previously-broken placement)', async () => {
    // Staff publish the listing by manually moving it to `available` (source
    // 'manual') — a BASELINE state. The OLD source-precedence rule pinned it and
    // blocked the placement from ever deriving it forward, so the listing stayed
    // publicly shareable while under application. New rule: baseline states are
    // derivation-eligible, so the placement drives it to under_application.
    await svc.setListingStatus('unit-1', { toStatus: 'available', source: 'manual' });
    const c = await world.placementsRepo.create({ tenantId: 'tenant-1', unitId: 'unit-1', stage: 'send_application' });
    await svc.transitionPlacement(c.placementId, { toStage: 'awaiting_approval', source: 'manual' });
    const unit = await world.unitsRepo.getById('unit-1');
    expect(unit!.status).toBe('under_application'); // derived forward despite the manual 'available'
    expect(unit!.status_source).toBe('derived');
  });

  it('derivation OVERWRITES a manually-set BASELINE tenant status (searching → placing)', async () => {
    await svc.setTenantStatus('tenant-1', { toStatus: 'searching', source: 'manual' });
    const c = await world.placementsRepo.create({ tenantId: 'tenant-1', unitId: 'unit-1', stage: 'send_application' });
    await svc.transitionPlacement(c.placementId, { toStage: 'awaiting_approval', source: 'manual' });
    const contact = await world.contactsRepo.getById('tenant-1');
    expect(contact!.status).toBe('placing'); // derived forward despite the manual 'searching'
    expect(contact!.status_source).toBe('derived');
  });

  it('derivation does NOT overwrite an OVERRIDE listing status (on_hold / off_market stay pinned)', async () => {
    for (const override of ['on_hold', 'off_market'] as const) {
      const world2 = createFakeWorld();
      const svc2 = makeService(world2);
      await world2.contactsRepo.create({ contactId: 'tenant-1', type: 'tenant' });
      await world2.unitsRepo.create({ unitId: 'unit-1', landlordId: 'll-1', status: 'available' });
      await svc2.setListingStatus('unit-1', { toStatus: override, source: 'manual' });
      const c = await world2.placementsRepo.create({ tenantId: 'tenant-1', unitId: 'unit-1', stage: 'send_application' });
      await svc2.transitionPlacement(c.placementId, { toStage: 'awaiting_approval', source: 'manual' });
      const unit = await world2.unitsRepo.getById('unit-1');
      expect(unit!.status, override).toBe(override); // override preserved
      expect(unit!.status_source, override).toBe('manual');
    }
  });

  it('derivation does NOT overwrite an OVERRIDE tenant status (on_hold / inactive stay pinned)', async () => {
    for (const override of ['on_hold', 'inactive'] as const) {
      const world2 = createFakeWorld();
      const svc2 = makeService(world2);
      await world2.contactsRepo.create({ contactId: 'tenant-1', type: 'tenant' });
      await world2.unitsRepo.create({ unitId: 'unit-1', landlordId: 'll-1', status: 'available' });
      await svc2.setTenantStatus('tenant-1', { toStatus: override, source: 'manual' });
      const c = await world2.placementsRepo.create({ tenantId: 'tenant-1', unitId: 'unit-1', stage: 'send_application' });
      await svc2.transitionPlacement(c.placementId, { toStage: 'awaiting_approval', source: 'manual' });
      const contact = await world2.contactsRepo.getById('tenant-1');
      expect(contact!.status, override).toBe(override); // override preserved
      expect(contact!.status_source, override).toBe('manual');
    }
  });

  it('moving a listing OUT of an override (on_hold → available) re-enables derivation', async () => {
    await svc.setListingStatus('unit-1', { toStatus: 'on_hold', source: 'manual' });
    const c = await world.placementsRepo.create({ tenantId: 'tenant-1', unitId: 'unit-1', stage: 'send_application' });
    // While on_hold, the placement transition does NOT derive it forward.
    await svc.transitionPlacement(c.placementId, { toStage: 'awaiting_approval', source: 'manual' });
    expect((await world.unitsRepo.getById('unit-1'))!.status).toBe('on_hold');
    // A human moves it back OUT of the override (explicit write always applies).
    await svc.setListingStatus('unit-1', { toStatus: 'available', source: 'manual' });
    // A subsequent placement transition now derives it forward.
    await svc.transitionPlacement(c.placementId, { toStage: 'awaiting_hap_contract', source: 'manual' });
    const unit = await world.unitsRepo.getById('unit-1');
    expect(unit!.status).toBe('finalizing');
    expect(unit!.status_source).toBe('derived');
  });

  it('a manually on_hold tenant on a moved_in placement STAYS on_hold (derivation skipped)', async () => {
    await svc.setTenantStatus('tenant-1', { toStatus: 'on_hold', source: 'manual' });
    const c = await world.placementsRepo.create({ tenantId: 'tenant-1', unitId: 'unit-1', stage: 'awaiting_move_in' });
    // moved_in would derive tenant→placed / listing→occupied, but on_hold pins.
    await svc.transitionPlacement(c.placementId, { toStage: 'moved_in', source: 'manual' });
    expect((await world.contactsRepo.getById('tenant-1'))!.status).toBe('on_hold'); // pinned
    // The (baseline 'available') listing is NOT pinned, so it derives to occupied.
    expect((await world.unitsRepo.getById('unit-1'))!.status).toBe('occupied');
  });

  it('an explicit (non-derived) write always applies — moving INTO an override over a derived value', async () => {
    const c = await world.placementsRepo.create({ tenantId: 'tenant-1', unitId: 'unit-1', stage: 'send_application' });
    await svc.transitionPlacement(c.placementId, { toStage: 'awaiting_approval', source: 'manual' });
    expect((await world.unitsRepo.getById('unit-1'))!.status).toBe('under_application'); // derived

    await svc.setListingStatus('unit-1', { toStatus: 'on_hold', source: 'manual' });
    const unit = await world.unitsRepo.getById('unit-1');
    expect(unit!.status).toBe('on_hold'); // explicit write applies unconditionally
    expect(unit!.status_source).toBe('manual');
  });
});

// Change 2 + 3: derived status writes must (2) audit a {from,to,source:'derived'}
// row with NO actor when the coarse status genuinely CHANGES, and (3) be a true
// no-op (no update, no audit) when the derived value already equals the current
// status — an idempotent mid-pipeline advance must not rewrite provenance or
// spam history. Covers both applyDerivation and the lost-bounce (shared helper).
describe('statusTransition — derived status audit + no-op guard (Changes 2 & 3)', () => {
  let world: FakeWorld;
  let svc: StatusTransitionService;

  beforeEach(async () => {
    world = createFakeWorld();
    svc = makeService(world);
    await world.contactsRepo.create({ contactId: 'tenant-1', type: 'tenant' });
    await world.unitsRepo.create({ unitId: 'unit-1', landlordId: 'll-1', status: 'available' });
  });

  const seed = (stage: string) =>
    world.placementsRepo.create({ tenantId: 'tenant-1', unitId: 'unit-1', stage: stage as never });

  it('Change 2: a CHANGE on both sides appends derived {from,to,source} audit rows with NO actor', async () => {
    const c = await seed('send_application');
    // Application phase derives tenant: undefined→placing, listing: available→under_application.
    await svc.transitionPlacement(c.placementId, { toStage: 'awaiting_approval', source: 'manual', actor: 'usr_va' });

    const tenantAudit = world.auditEvents.filter((a) => a.event_type === 'tenant_status_changed');
    const listingAudit = world.auditEvents.filter((a) => a.event_type === 'listing_status_changed');
    expect(tenantAudit).toHaveLength(1);
    expect(listingAudit).toHaveLength(1);
    // Derived is SYSTEM — no actor (even though the placement move carried one).
    expect(tenantAudit[0]!.actorId).toBeUndefined();
    expect(tenantAudit[0]!.payload).not.toHaveProperty('actor');
    expect(tenantAudit[0]!.payload).toMatchObject({ to: 'placing', source: 'derived' });
    expect(tenantAudit[0]!.entityKey).toBe('contacts#tenant-1');
    expect(listingAudit[0]!.payload).toMatchObject({ from: 'available', to: 'under_application', source: 'derived' });
    expect(listingAudit[0]!.entityKey).toBe('units#unit-1');
  });

  it('Change 3: a mid-pipeline advance where the TENANT status is unchanged writes NO tenant update/audit', async () => {
    const c = await seed('send_application');
    // First move → tenant placing (a change, audited once).
    await svc.transitionPlacement(c.placementId, { toStage: 'awaiting_approval', source: 'manual' });
    expect((await world.contactsRepo.getById('tenant-1'))!.status).toBe('placing');
    const tenantAuditAfterFirst = world.auditEvents.filter((a) => a.event_type === 'tenant_status_changed').length;
    expect(tenantAuditAfterFirst).toBe(1);

    // Spy: count contactsRepo.update calls during the SECOND advance.
    let tenantUpdates = 0;
    const realUpdate = world.contactsRepo.update.bind(world.contactsRepo);
    world.contactsRepo.update = async (id, patch) => {
      tenantUpdates += 1;
      return realUpdate(id, patch);
    };

    // Contract phase: tenant STAYS placing (unchanged) while listing changes
    // under_application→finalizing. The tenant side must be a pure no-op.
    await svc.transitionPlacement(c.placementId, { toStage: 'awaiting_hap_contract', source: 'manual' });

    expect(tenantUpdates).toBe(0); // no write for the unchanged tenant
    const tenantAuditAfterSecond = world.auditEvents.filter((a) => a.event_type === 'tenant_status_changed').length;
    expect(tenantAuditAfterSecond).toBe(1); // no new tenant audit row
    // The listing side DID change → it gets a fresh audit row.
    const listingChanges = world.auditEvents.filter(
      (a) => a.event_type === 'listing_status_changed' && (a.payload as { to?: string }).to === 'finalizing',
    );
    expect(listingChanges).toHaveLength(1);
    expect((await world.unitsRepo.getById('unit-1'))!.status).toBe('finalizing');
  });

  it('Change 3: re-applying the SAME stage (both sides unchanged) writes no derived update/audit at all', async () => {
    const c = await seed('send_application');
    await svc.transitionPlacement(c.placementId, { toStage: 'awaiting_approval', source: 'manual' });
    // Re-derive the same coarse statuses (tenant placing, listing under_application).
    let tenantUpdates = 0;
    let listingUpdates = 0;
    const realTenantUpdate = world.contactsRepo.update.bind(world.contactsRepo);
    const realUnitUpdate = world.unitsRepo.update.bind(world.unitsRepo);
    world.contactsRepo.update = async (id, patch) => { tenantUpdates += 1; return realTenantUpdate(id, patch); };
    world.unitsRepo.update = async (id, patch) => { listingUpdates += 1; return realUnitUpdate(id, patch); };
    const auditBefore = world.auditEvents.length;

    // A no-op pipeline re-entry (e.g. a redelivered stage advance to the same
    // derived coarse statuses). placement_stage_changed still audits; derived sides don't.
    await svc.transitionPlacement(c.placementId, { toStage: 'awaiting_approval', source: 'manual' });

    expect(tenantUpdates).toBe(0);
    expect(listingUpdates).toBe(0);
    const newRows = world.auditEvents.slice(auditBefore);
    expect(newRows.some((a) => a.event_type === 'tenant_status_changed')).toBe(false);
    expect(newRows.some((a) => a.event_type === 'listing_status_changed')).toBe(false);
  });

  it('lost-bounce goes through the SAME derived audit path (audits a derived bounce row, no actor)', async () => {
    const c = await world.placementsRepo.create({ tenantId: 'tenant-1', unitId: 'unit-1', stage: 'awaiting_inspection' });
    // Drive tenant→placing / listing→under_application first so the bounce is a real change.
    await svc.transitionPlacement(c.placementId, { toStage: 'awaiting_approval', source: 'manual' });
    const tenantRowsBefore = world.auditEvents.filter((a) => a.event_type === 'tenant_status_changed').length;

    await svc.transitionPlacement(c.placementId, { toStage: 'lost', source: 'manual', actor: 'usr_va', lostReason: { category: 'stalled' } });

    // The bounce derived tenant placing→searching: a NEW derived audit row, no actor.
    const tenantRows = world.auditEvents.filter((a) => a.event_type === 'tenant_status_changed');
    expect(tenantRows.length).toBe(tenantRowsBefore + 1);
    const bounce = tenantRows[tenantRows.length - 1]!;
    expect(bounce.payload).toMatchObject({ from: 'placing', to: 'searching', source: 'derived' });
    expect(bounce.actorId).toBeUndefined();
  });
});

// The RTA-in-hand→searching gate was REMOVED (product decision 2026-06-19):
// RTA-in-hand is a manual business prerequisite — the admin advances the tenant
// when it's satisfied, or holds them in `on_hold` if not — so setTenantStatus
// always applies (subject only to the entity existing). `porting` stays as an
// informational flag and gates nothing.
describe('statusTransition — tenant status (no RTA-in-hand gate, §5; 2026-06-19)', () => {
  let world: FakeWorld;
  let svc: StatusTransitionService;

  beforeEach(() => {
    world = createFakeWorld();
    svc = makeService(world);
  });

  it('→searching SUCCEEDS regardless of rta_in_hand / porting (gate removed); audits {from,to,source}', async () => {
    // A tenant with NO rta_in_hand AND porting:true — the old gate would have
    // refused this with a 409 rta_gate. It must now succeed.
    await world.contactsRepo.create({
      contactId: 't-gateless',
      type: 'tenant',
      status: 'onboarding',
      porting: true,
    });
    const updated = await svc.setTenantStatus('t-gateless', { toStatus: 'searching', source: 'manual' });
    expect(updated.status).toBe('searching');
    expect(updated.status_source).toBe('manual');
    // porting stays informational — untouched when not supplied, never a gate.
    expect(updated.porting).toBe(true);
    const audit = world.auditEvents.find((a) => a.event_type === 'tenant_status_changed');
    expect(audit!.payload).toMatchObject({ from: 'onboarding', to: 'searching', source: 'manual' });
  });

  it('→searching also succeeds when porting is updated in the same write (porting is just a flag)', async () => {
    await world.contactsRepo.create({ contactId: 't-port', type: 'tenant', porting: true });
    const ok = await svc.setTenantStatus('t-port', { toStatus: 'searching', source: 'manual', porting: false });
    expect(ok.status).toBe('searching');
    expect(ok.porting).toBe(false);
  });

  it('manual drop-out to inactive is allowed (no gate); porting is a flag, never a stage', async () => {
    await world.contactsRepo.create({ contactId: 't-drop', type: 'tenant' });
    const updated = await svc.setTenantStatus('t-drop', { toStatus: 'inactive', source: 'manual' });
    expect(updated.status).toBe('inactive');
    // porting lives on the contact, never appears as a placement stage.
    expect(updated).not.toHaveProperty('stage');
  });
});

// Landlord lead lifecycle (docs/issues/landlord-lead-status-and-park.md): the
// shared setter (all contact types route through setTenantStatus) persists
// `park_reason` when the target status is `parked`, from the supplied reason.
describe('statusTransition — park_reason on the move to parked', () => {
  let world: FakeWorld;
  let svc: StatusTransitionService;

  beforeEach(() => {
    world = createFakeWorld();
    svc = makeService(world);
  });

  it('persists park_reason on the contact when a landlord is moved to parked', async () => {
    await world.contactsRepo.create({ contactId: 'll-park', type: 'landlord', status: 'interested' });
    const updated = await svc.setTenantStatus('ll-park', {
      toStatus: 'parked',
      source: 'manual',
      reason: 'never signed the contract',
    });
    expect(updated.status).toBe('parked');
    expect(updated.park_reason).toBe('never signed the contract');
    expect((await world.contactsRepo.getById('ll-park'))!.park_reason).toBe('never signed the contract');
  });

  it('does NOT set park_reason on a non-parked move (a tenant on_hold leaves park_reason untouched)', async () => {
    await world.contactsRepo.create({ contactId: 't-hold', type: 'tenant', status: 'onboarding' });
    const updated = await svc.setTenantStatus('t-hold', { toStatus: 'on_hold', source: 'manual', reason: 'paused' });
    expect(updated.status).toBe('on_hold');
    expect(updated).not.toHaveProperty('park_reason');
  });
});

describe('statusTransition — inspection_outcome on the inspection-complete move (§4)', () => {
  let world: FakeWorld;
  let svc: StatusTransitionService;

  beforeEach(async () => {
    world = createFakeWorld();
    svc = makeService(world);
    await world.contactsRepo.create({ contactId: 'tenant-1', type: 'tenant' });
    await world.unitsRepo.create({ unitId: 'unit-1', landlordId: 'll-1', status: 'available' });
  });

  it("writes inspection_outcome:'pass' on awaiting_inspection → determine_rent", async () => {
    const c = await world.placementsRepo.create({ tenantId: 'tenant-1', unitId: 'unit-1', stage: 'awaiting_inspection' });
    const updated = await svc.transitionPlacement(c.placementId, {
      toStage: 'determine_rent',
      source: 'manual',
      inspectionOutcome: 'pass',
    });
    expect(updated.inspection_outcome).toBe('pass');
  });

  it("stores a 'fail' too — including on awaiting_inspection → lost and → schedule_inspection", async () => {
    const toLost = await world.placementsRepo.create({ tenantId: 'tenant-1', unitId: 'unit-1', stage: 'awaiting_inspection' });
    const lost = await svc.transitionPlacement(toLost.placementId, {
      toStage: 'lost',
      source: 'manual',
      inspectionOutcome: 'fail',
      lostReason: { category: 'landlord_lost_inspection' },
    });
    expect(lost.inspection_outcome).toBe('fail');

    const reschedule = await world.placementsRepo.create({ tenantId: 'tenant-1', unitId: 'unit-1', stage: 'awaiting_inspection' });
    const back = await svc.transitionPlacement(reschedule.placementId, {
      toStage: 'schedule_inspection',
      source: 'manual',
      inspectionOutcome: 'fail',
    });
    expect(back.inspection_outcome).toBe('fail');
  });

  it('does NOT write inspection_outcome on a move that is NOT from awaiting_inspection', async () => {
    const c = await world.placementsRepo.create({ tenantId: 'tenant-1', unitId: 'unit-1', stage: 'schedule_inspection' });
    const updated = await svc.transitionPlacement(c.placementId, {
      toStage: 'awaiting_inspection',
      source: 'manual',
      // A stray outcome on a non-inspection-complete move is ignored (gated on
      // `from === 'awaiting_inspection'`, mirroring finalRent's gate).
      inspectionOutcome: 'pass',
    });
    expect(updated.inspection_outcome).toBeUndefined();
  });

  it('rejects an invalid inspectionOutcome defensively at the service', async () => {
    const c = await world.placementsRepo.create({ tenantId: 'tenant-1', unitId: 'unit-1', stage: 'awaiting_inspection' });
    await expect(
      // @ts-expect-error — exercising the defensive runtime guard with a junk value.
      svc.transitionPlacement(c.placementId, { toStage: 'determine_rent', source: 'manual', inspectionOutcome: 'maybe' }),
    ).rejects.toBeInstanceOf(TransitionRefusedError);
  });
});

describe('statusTransition — final_rent on rent acceptance (§4)', () => {
  it('does NOT write final_rent when ENTERING awaiting_rent_acceptance', async () => {
    const world = createFakeWorld();
    const svc = makeService(world);
    await world.contactsRepo.create({ contactId: 'tenant-1', type: 'tenant' });
    await world.unitsRepo.create({ unitId: 'unit-1', landlordId: 'll-1', status: 'available' });
    const c = await world.placementsRepo.create({ tenantId: 'tenant-1', unitId: 'unit-1', stage: 'determine_rent' });
    // Entering awaiting_rent_acceptance is the "still awaiting acceptance" state —
    // the rent is not yet accepted, so nothing is written even if finalRent leaks in.
    await svc.transitionPlacement(c.placementId, { toStage: 'awaiting_rent_acceptance', source: 'manual', finalRent: 1825 });
    expect((await world.unitsRepo.getById('unit-1'))!.final_rent).toBeUndefined();
  });

  it('writes final_rent onto the unit when LEAVING awaiting_rent_acceptance (the accept move)', async () => {
    const world = createFakeWorld();
    const svc = makeService(world);
    await world.contactsRepo.create({ contactId: 'tenant-1', type: 'tenant' });
    await world.unitsRepo.create({ unitId: 'unit-1', landlordId: 'll-1', status: 'available' });
    const c = await world.placementsRepo.create({ tenantId: 'tenant-1', unitId: 'unit-1', stage: 'awaiting_rent_acceptance' });
    // The landlord accepts → move OUT of awaiting_rent_acceptance, carrying the
    // accepted amount → final_rent lands on the unit (§4).
    await svc.transitionPlacement(c.placementId, { toStage: 'awaiting_hap_contract', source: 'manual', finalRent: 1825 });
    expect((await world.unitsRepo.getById('unit-1'))!.final_rent).toBe(1825);
  });

  it('does NOT write final_rent when LEAVING awaiting_rent_acceptance for the TERMINAL `lost` (a dying deal is not an acceptance)', async () => {
    const world = createFakeWorld();
    const svc = makeService(world);
    await world.contactsRepo.create({ contactId: 'tenant-1', type: 'tenant' });
    await world.unitsRepo.create({ unitId: 'unit-1', landlordId: 'll-1', status: 'available' });
    const c = await world.placementsRepo.create({ tenantId: 'tenant-1', unitId: 'unit-1', stage: 'awaiting_rent_acceptance' });
    // awaiting_rent_acceptance → lost is the deal dying, NOT a rent acceptance,
    // so final_rent must never be stamped onto the unit even if a stray
    // finalRent rides along on the move (edge guard #5).
    await svc.transitionPlacement(c.placementId, {
      toStage: 'lost',
      source: 'manual',
      finalRent: 1825,
      lostReason: { category: 'landlord_lost_rent' },
    });
    expect((await world.unitsRepo.getById('unit-1'))!.final_rent).toBeUndefined();
  });
});

describe('statusTransition — Lost from any stage (§7)', () => {
  let world: FakeWorld;
  let svc: StatusTransitionService;

  beforeEach(async () => {
    world = createFakeWorld();
    svc = makeService(world);
    await world.contactsRepo.create({ contactId: 'tenant-1', type: 'tenant' });
    await world.unitsRepo.create({ unitId: 'unit-1', landlordId: 'll-1', status: 'available' });
  });

  it('stores the structured {category,text} reason and bounces tenant→searching / listing→available when no other active placement', async () => {
    const c = await world.placementsRepo.create({ tenantId: 'tenant-1', unitId: 'unit-1', stage: 'awaiting_inspection' });
    const updated = await svc.transitionPlacement(c.placementId, {
      toStage: 'lost',
      source: 'manual',
      lostReason: { category: 'landlord_lost_inspection', text: 'failed twice' },
    });
    expect(updated.stage).toBe('lost');
    expect(updated.lost_reason).toEqual({ category: 'landlord_lost_inspection', text: 'failed twice' });
    // No other active placement → bounce back.
    expect((await world.contactsRepo.getById('tenant-1'))!.status).toBe('searching');
    expect((await world.unitsRepo.getById('unit-1'))!.status).toBe('available');
  });

  it('does NOT bounce an OVERRIDE-pinned tenant on a lost placement (manual on_hold survives)', async () => {
    // A manually On-hold tenant must STAY On hold through a lost placement —
    // the lost-bounce is a derived write, gated on the current override state.
    await svc.setTenantStatus('tenant-1', { toStatus: 'on_hold', source: 'manual' });
    const c = await world.placementsRepo.create({ tenantId: 'tenant-1', unitId: 'unit-1', stage: 'awaiting_inspection' });
    await svc.transitionPlacement(c.placementId, { toStage: 'lost', source: 'manual', lostReason: { category: 'stalled' } });
    expect((await world.contactsRepo.getById('tenant-1'))!.status).toBe('on_hold'); // pinned, no bounce
    // The listing (baseline 'available') is not pinned, so it bounces to available.
    expect((await world.unitsRepo.getById('unit-1'))!.status).toBe('available');
  });

  it('does NOT bounce when ANOTHER active placement exists on the tenant/unit', async () => {
    // Two placements for the same tenant on the same unit; one stays active.
    const active = await world.placementsRepo.create({ tenantId: 'tenant-1', unitId: 'unit-1', stage: 'awaiting_approval' });
    // Drive the active one's derivation so tenant=placing / listing=under_application.
    await svc.transitionPlacement(active.placementId, { toStage: 'awaiting_approval', source: 'manual' });
    const losing = await world.placementsRepo.create({ tenantId: 'tenant-1', unitId: 'unit-1', stage: 'awaiting_inspection' });
    await svc.transitionPlacement(losing.placementId, { toStage: 'lost', source: 'manual', lostReason: { category: 'stalled' } });
    // The OTHER placement is still active → no bounce-back.
    expect((await world.contactsRepo.getById('tenant-1'))!.status).toBe('placing');
    expect((await world.unitsRepo.getById('unit-1'))!.status).toBe('under_application');
  });

  it('does NOT bounce when the active sibling is on the SECOND page (paginated sibling scan)', async () => {
    // Change 1: the sibling-placement scan must follow lastEvaluatedKey, not
    // decide off the first page. We wrap the fake placementsRepo so listByTenant /
    // listByUnit ALWAYS return two pages: page 1 = only the losing/terminal placement
    // (no active sibling), page 2 (returned only when exclusiveStartKey is set)
    // contains the ACTIVE sibling. If the scan reads page 1 only it would wrongly
    // bounce; following the cursor finds the sibling and suppresses the bounce.
    const active = await world.placementsRepo.create({
      tenantId: 'tenant-1',
      unitId: 'unit-1',
      stage: 'awaiting_approval',
    });
    // Make tenant=placing / listing=under_application via the active placement.
    await svc.transitionPlacement(active.placementId, { toStage: 'awaiting_approval', source: 'manual' });
    const losing = await world.placementsRepo.create({
      tenantId: 'tenant-1',
      unitId: 'unit-1',
      stage: 'awaiting_inspection',
    });

    const PAGE_CURSOR = { placementId: '__page2__' };
    const twoPageScan = (all: typeof active[]) => (opts: { exclusiveStartKey?: Record<string, unknown> }) => {
      // Page 2 (cursor present): the active sibling only.
      if (opts.exclusiveStartKey !== undefined) {
        return { items: all.filter((c) => c.placementId === active.placementId).map((c) => ({ ...c })) };
      }
      // Page 1 (no cursor): the losing placement only, with a lastEvaluatedKey so the
      // service must follow the cursor to page 2.
      return {
        items: all.filter((c) => c.placementId === losing.placementId).map((c) => ({ ...c })),
        lastEvaluatedKey: PAGE_CURSOR,
      };
    };

    const pagedRepo = {
      ...world.placementsRepo,
      async listByTenant(tenantId: string, opts: { exclusiveStartKey?: Record<string, unknown> } = {}) {
        const all = (await world.placementsRepo.listByTenant(tenantId)).items;
        return twoPageScan(all)(opts);
      },
      async listByUnit(unitId: string, opts: { exclusiveStartKey?: Record<string, unknown> } = {}) {
        const all = (await world.placementsRepo.listByUnit(unitId)).items;
        return twoPageScan(all)(opts);
      },
    };
    const pagedSvc = createStatusTransitionService({
      placementsRepo: pagedRepo as typeof world.placementsRepo,
      placementDeadlinesRepo: world.placementDeadlinesRepo,
      unitsRepo: world.unitsRepo,
      contactsRepo: world.contactsRepo,
      auditRepo: world.auditRepo,
      events: world.events,
      logger: createLogger({ destination: createLogCapture().stream }),
    });

    await pagedSvc.transitionPlacement(losing.placementId, {
      toStage: 'lost',
      source: 'manual',
      lostReason: { category: 'stalled' },
    });
    // The active sibling was on page 2 → detected → NO bounce-back.
    expect((await world.contactsRepo.getById('tenant-1'))!.status).toBe('placing');
    expect((await world.unitsRepo.getById('unit-1'))!.status).toBe('under_application');
  });
});

describe('statusTransition — deadline items (no stored stuck nudge)', () => {
  let world: FakeWorld;
  let svc: StatusTransitionService;

  beforeEach(async () => {
    world = createFakeWorld();
    svc = makeService(world);
    await world.contactsRepo.create({ contactId: 'tenant-1', type: 'tenant' });
    await world.unitsRepo.create({ unitId: 'unit-1', landlordId: 'll-1', status: 'available' });
  });

  it('a non-RTA stage move arms NO deadline (stuck is DERIVED in today.ts now)', async () => {
    const c = await world.placementsRepo.create({ tenantId: 'tenant-1', unitId: 'unit-1', stage: 'send_application' });
    await svc.transitionPlacement(c.placementId, { toStage: 'awaiting_hap_contract', source: 'manual' });
    // No stored stuck_placement deadline — the transition arms nothing here.
    expect(await world.placementDeadlinesRepo.listByPlacement(c.placementId)).toHaveLength(0);
  });

  it('a non-RTA stage move leaves an independent hard clock (rta_window) intact', async () => {
    const c = await world.placementsRepo.create({ tenantId: 'tenant-1', unitId: 'unit-1', stage: 'collect_rta' });
    // A pending rta_window item on a stage that does NOT own it (independent).
    await world.placementDeadlinesRepo.arm(c.placementId, 'rta_window', '2026-09-01T00:00:00.000Z');
    await svc.transitionPlacement(c.placementId, { toStage: 'review_rta', source: 'manual' });
    const rows = await world.placementDeadlinesRepo.listByPlacement(c.placementId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.type).toBe('rta_window'); // untouched (not the owning stage)
    expect(rows[0]!.at).toBe('2026-09-01T00:00:00.000Z');
  });

  it('a terminal stage clears ALL of a placement’s deadlines (clearForPlacement)', async () => {
    const c = await world.placementsRepo.create({ tenantId: 'tenant-1', unitId: 'unit-1', stage: 'collect_rta' });
    // Two independent hard clocks pending.
    await world.placementDeadlinesRepo.arm(c.placementId, 'rta_window', '2026-09-01T00:00:00.000Z');
    await world.placementDeadlinesRepo.arm(c.placementId, 'voucher_expiration', '2026-12-01T00:00:00.000Z');
    await svc.transitionPlacement(c.placementId, { toStage: 'moved_in', source: 'manual' });
    // A closed deal never fires a deadline — everything cleared.
    expect(await world.placementDeadlinesRepo.listByPlacement(c.placementId)).toHaveLength(0);
  });
});

// Task 5 (Post-Tour & Application): the transition choke point ALSO (a) arms the
// RTA 48h hard clock on entering awaiting_landlord_submission, (b) invokes the
// optional armStageNudge hook (stage-application nudge ladder) on every move, and
// (c) invokes the optional closeRelayForLostPlacement hook on a lost move. Both
// hooks are best-effort and OPTIONAL — absent, behavior is identical to before
// (proven by every test above, none of which pass hooks).
describe('statusTransition — RTA 48h hard clock + choke-point hooks (Task 5)', () => {
  const RTA_WINDOW_MS = 48 * 60 * 60 * 1000;
  let world: FakeWorld;

  beforeEach(async () => {
    world = createFakeWorld();
    await world.contactsRepo.create({ contactId: 'tenant-1', type: 'tenant' });
    await world.unitsRepo.create({ unitId: 'unit-1', landlordId: 'll-1', status: 'available' });
  });

  it('entering awaiting_landlord_submission arms an rta_window item at EXACTLY stage-entry+48h', async () => {
    const svc = makeService(world); // no hooks — the RTA clock is unconditional
    const c = await world.placementsRepo.create({
      tenantId: 'tenant-1',
      unitId: 'unit-1',
      stage: 'send_rta_to_landlord',
    });
    const updated = await svc.transitionPlacement(c.placementId, {
      toStage: 'awaiting_landlord_submission',
      source: 'manual',
    });
    const rows = await world.placementDeadlinesRepo.listByPlacement(c.placementId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.type).toBe('rta_window');
    // stage_entered_at and the rta_window deadline derive from the SAME `now`, so
    // the deadline is exactly stage-entry + 48h (deterministic, no tolerance).
    expect(Date.parse(rows[0]!.at)).toBe(Date.parse(updated.stage_entered_at!) + RTA_WINDOW_MS);
  });

  it('the rta_window item is the placement’s soonest deadline after entering the stage', async () => {
    const svc = makeService(world);
    const c = await world.placementsRepo.create({
      tenantId: 'tenant-1',
      unitId: 'unit-1',
      stage: 'send_rta_to_landlord',
    });
    await svc.transitionPlacement(c.placementId, { toStage: 'awaiting_landlord_submission', source: 'manual' });
    expect(await deadlineTypeOf(world, c.placementId)).toBe('rta_window');
  });

  it('entering awaiting_receipt invokes armStageNudge with the UPDATED placement + toStage + an ISO now', async () => {
    const calls: Array<{ placement: PlacementItem; toStage: string; nowIso: string }> = [];
    const svc = makeServiceWith(world, {
      armStageNudge: async (placement, toStage, nowIso) => {
        calls.push({ placement, toStage, nowIso });
      },
    });
    const c = await world.placementsRepo.create({ tenantId: 'tenant-1', unitId: 'unit-1', stage: 'send_application' });
    await svc.transitionPlacement(c.placementId, { toStage: 'awaiting_receipt', source: 'manual' });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.toStage).toBe('awaiting_receipt');
    // The hook gets the POST-transition placement (stage already advanced).
    expect(calls[0]!.placement.placementId).toBe(c.placementId);
    expect(calls[0]!.placement.stage).toBe('awaiting_receipt');
    // now is a real ISO 8601 string.
    expect(calls[0]!.nowIso).toBe(new Date(calls[0]!.nowIso).toISOString());
  });

  it('a lost move invokes closeRelayForLostPlacement AND clears all deadline items (terminal behavior preserved)', async () => {
    const closed: PlacementItem[] = [];
    const armed: Array<{ placement: PlacementItem; toStage: string }> = [];
    const svc = makeServiceWith(world, {
      closeRelayForLostPlacement: async (placement) => {
        closed.push(placement);
      },
      armStageNudge: async (placement, toStage) => {
        armed.push({ placement, toStage });
      },
    });
    const c = await world.placementsRepo.create({
      tenantId: 'tenant-1',
      unitId: 'unit-1',
      stage: 'awaiting_approval',
      group_thread: 'conv-relay-1',
    });
    // Give it a pending deadline so we can prove the terminal move clears it.
    await world.placementDeadlinesRepo.arm(c.placementId, 'follow_up', '2026-09-01T00:00:00.000Z');

    await svc.transitionPlacement(c.placementId, { toStage: 'lost', source: 'manual', lostReason: { category: 'stalled' } });

    // The relay-close hook fired once, with the POST-transition (lost) placement.
    expect(closed).toHaveLength(1);
    expect(closed[0]!.stage).toBe('lost');
    expect(closed[0]!.group_thread).toBe('conv-relay-1');
    // Terminal clearing is unchanged in effect: the pending deadline is gone.
    expect(await world.placementDeadlinesRepo.listByPlacement(c.placementId)).toHaveLength(0);
    // The arm hook ALSO fires on lost (its cancel-only path retires pending rows).
    expect(armed).toHaveLength(1);
    expect(armed[0]!.toStage).toBe('lost');
  });

  it('closeRelayForLostPlacement is NOT invoked on a non-lost move', async () => {
    const closed: PlacementItem[] = [];
    const svc = makeServiceWith(world, {
      closeRelayForLostPlacement: async (placement) => {
        closed.push(placement);
      },
    });
    const c = await world.placementsRepo.create({
      tenantId: 'tenant-1',
      unitId: 'unit-1',
      stage: 'send_application',
      group_thread: 'conv-relay-1',
    });
    await svc.transitionPlacement(c.placementId, { toStage: 'awaiting_receipt', source: 'manual' });
    expect(closed).toHaveLength(0);
  });

  it('a hook that throws NEVER fails the transition (best-effort)', async () => {
    const svc = makeServiceWith(world, {
      armStageNudge: async () => {
        throw new Error('boom');
      },
      closeRelayForLostPlacement: async () => {
        throw new Error('boom');
      },
    });
    const c = await world.placementsRepo.create({ tenantId: 'tenant-1', unitId: 'unit-1', stage: 'awaiting_approval' });
    const updated = await svc.transitionPlacement(c.placementId, {
      toStage: 'lost',
      source: 'manual',
      lostReason: { category: 'stalled' },
    });
    expect(updated.stage).toBe('lost');
  });

  // rta_window is a STAGE-SCOPED clock OWNED by awaiting_landlord_submission:
  // leaving that stage must RETIRE the item (a plain independent DeleteItem — no
  // slot-clobber dance any more). The destination stage arms NOTHING (stuck is
  // derived in today.ts). These guard the retire + the independence.
  it('leaving awaiting_landlord_submission → awaiting_authority_approval RETIRES rta_window (and arms nothing)', async () => {
    const svc = makeService(world);
    const c = await world.placementsRepo.create({
      tenantId: 'tenant-1',
      unitId: 'unit-1',
      stage: 'send_rta_to_landlord',
    });
    // Enter awaiting_landlord_submission → arms the rta_window hard clock.
    await svc.transitionPlacement(c.placementId, { toStage: 'awaiting_landlord_submission', source: 'manual' });
    expect(await deadlineTypeOf(world, c.placementId)).toBe('rta_window');

    await svc.transitionPlacement(c.placementId, { toStage: 'awaiting_authority_approval', source: 'manual' });

    // The rta_window item is retired; no stuck deadline is armed at the destination.
    expect(await world.placementDeadlinesRepo.listByPlacement(c.placementId)).toHaveLength(0);
  });

  it('leaving awaiting_landlord_submission → lost clears via clearForPlacement (terminal path unchanged)', async () => {
    const svc = makeService(world);
    const c = await world.placementsRepo.create({
      tenantId: 'tenant-1',
      unitId: 'unit-1',
      stage: 'send_rta_to_landlord',
    });
    await svc.transitionPlacement(c.placementId, { toStage: 'awaiting_landlord_submission', source: 'manual' });
    expect(await deadlineTypeOf(world, c.placementId)).toBe('rta_window');

    await svc.transitionPlacement(c.placementId, { toStage: 'lost', source: 'manual', lostReason: { category: 'stalled' } });
    expect(await world.placementDeadlinesRepo.listByPlacement(c.placementId)).toHaveLength(0);
  });

  it('a pending voucher_expiration is NEVER touched by a stage move (tenant-level, not stage-scoped)', async () => {
    const svc = makeService(world);
    const c = await world.placementsRepo.create({ tenantId: 'tenant-1', unitId: 'unit-1', stage: 'collect_rta' });
    // voucher_expiration is tenant-level — a stage move must not re-arm or retire it.
    await world.placementDeadlinesRepo.arm(c.placementId, 'voucher_expiration', '2026-12-01T00:00:00.000Z');
    await svc.transitionPlacement(c.placementId, { toStage: 'review_rta', source: 'manual' });
    const rows = await world.placementDeadlinesRepo.listByPlacement(c.placementId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.type).toBe('voucher_expiration'); // untouched
    expect(rows[0]!.at).toBe('2026-12-01T00:00:00.000Z');
  });

  it('re-entering awaiting_landlord_submission re-arms a FRESH +48h rta_window item', async () => {
    const svc = makeService(world);
    const c = await world.placementsRepo.create({
      tenantId: 'tenant-1',
      unitId: 'unit-1',
      stage: 'send_rta_to_landlord',
    });
    // First entry, then leave (retiring the clock), then come back.
    await svc.transitionPlacement(c.placementId, { toStage: 'awaiting_landlord_submission', source: 'manual' });
    await svc.transitionPlacement(c.placementId, { toStage: 'awaiting_authority_approval', source: 'manual' });
    const reentered = await svc.transitionPlacement(c.placementId, {
      toStage: 'awaiting_landlord_submission',
      source: 'manual',
    });
    const rows = await world.placementDeadlinesRepo.listByPlacement(c.placementId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.type).toBe('rta_window');
    expect(Date.parse(rows[0]!.at)).toBe(Date.parse(reentered.stage_entered_at!) + RTA_WINDOW_MS);
  });
});

function makeServiceWithActivity(world: FakeWorld): StatusTransitionService {
  return createStatusTransitionService({
    placementsRepo: world.placementsRepo,
    unitsRepo: world.unitsRepo,
    contactsRepo: world.contactsRepo,
    auditRepo: world.auditRepo,
    activityEventsRepo: world.activityEventsRepo,
    events: world.events,
    logger: createLogger({ destination: createLogCapture().stream }),
  });
}

describe('statusTransition — contact_status_changed milestone', () => {
  let world: FakeWorld;
  beforeEach(async () => {
    world = createFakeWorld();
    // Landlord fixture — exercises the LANDLORD_STATUS_LABELS branch. Landlord
    // statuses are needs_review|interested|active|parked (statusModel.ts:173).
    await world.contactsRepo.create({ contactId: 'll-1', type: 'landlord', status: 'interested' });
  });

  it('records a contact_status_changed activity event on an explicit landlord status change', async () => {
    const svc = makeServiceWithActivity(world);
    await svc.setTenantStatus('ll-1', { toStatus: 'parked', source: 'manual', actor: 'usr_va' });
    const ev = world.activityEvents.filter((e) => e.type === 'contact_status_changed');
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ contactId: 'll-1', label: 'Status → Parked' }); // LANDLORD_STATUS_LABELS.parked
    expect(ev[0].refType).toBeUndefined();
  });

  it('does NOT record when the status is unchanged (no-op)', async () => {
    const svc = makeServiceWithActivity(world);
    await svc.setTenantStatus('ll-1', { toStatus: 'interested', source: 'manual', actor: 'usr_va' });
    expect(world.activityEvents.filter((e) => e.type === 'contact_status_changed')).toHaveLength(0);
  });

  it('never throws out of setTenantStatus if the milestone write fails (best-effort)', async () => {
    world.activityEventsRepo.record = async () => { throw new Error('boom'); };
    const svc = makeServiceWithActivity(world);
    await expect(svc.setTenantStatus('ll-1', { toStatus: 'parked', source: 'manual' })).resolves.toBeTruthy();
  });
});

describe('statusTransition — placement stage milestone', () => {
  let world: FakeWorld;
  beforeEach(async () => {
    world = createFakeWorld();
    await world.contactsRepo.create({ contactId: 'tenant-1', type: 'tenant' });
    await world.unitsRepo.create({ unitId: 'unit-1', landlordId: 'll-1', status: 'available' });
  });

  it('records a stage_changed milestone on a non-terminal move', async () => {
    const svc = makeServiceWithActivity(world);
    const p = await world.placementsRepo.create({ tenantId: 'tenant-1', unitId: 'unit-1', stage: 'send_application' });
    await svc.transitionPlacement(p.placementId, { toStage: 'collect_rta', source: 'manual', actor: 'usr_va' });
    const ev = world.activityEvents.filter((e) => e.type === 'stage_changed');
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ contactId: 'tenant-1', refType: 'placement', refId: p.placementId, label: expect.stringContaining('Collect RTA') });
  });

  it('records a placement_closed milestone (with lost category, no free text) on a terminal move', async () => {
    const svc = makeServiceWithActivity(world);
    const p = await world.placementsRepo.create({ tenantId: 'tenant-1', unitId: 'unit-1', stage: 'send_application' });
    // Category MUST be a valid lost-reason category (statusModel.ts:303-311) or
    // transitionPlacement drops it (isLostReasonCategory guard) → label omits it.
    await svc.transitionPlacement(p.placementId, { toStage: 'lost', source: 'manual', lostReason: { category: 'tenant_withdrew', text: 'secret note' } });
    const ev = world.activityEvents.filter((e) => e.type === 'placement_closed');
    expect(ev).toHaveLength(1);
    expect(ev[0].label).toContain('tenant_withdrew');
    expect(ev[0].label).not.toContain('secret note');
  });
});
