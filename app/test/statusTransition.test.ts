// Unit tests for THE one transition service (services/statusTransition.ts),
// driven on the in-memory fakes (no DynamoDB). Covers: stage stamping +
// provenance audit; §7 derivation; §8 source precedence (derived never
// overwrites a manual pin; manual overwrites derived); the §5 RTA-in-hand gate;
// porting as a tenant flag (never a stage); final_rent on rent acceptance; Lost
// from any stage (structured reason + the bounce-back guard); and the §8
// time-in-stage stuck nudge (incl. NOT clobbering a hard-clock deadline,
// terminal clearing).
import { beforeEach, describe, expect, it } from 'vitest';
import { createFakeWorld, type FakeWorld } from './helpers/twilioWebhookHarness.js';
import { createLogger } from '../src/lib/logger.js';
import { createLogCapture } from './helpers/logCapture.js';
import {
  createStatusTransitionService,
  EntityNotFoundError,
  TransitionRefusedError,
  type StatusTransitionService,
} from '../src/services/statusTransition.js';
import { STAGE_STUCK_THRESHOLDS } from '../src/lib/statusModel.js';

function makeService(world: FakeWorld): StatusTransitionService {
  return createStatusTransitionService({
    casesRepo: world.casesRepo,
    unitsRepo: world.unitsRepo,
    contactsRepo: world.contactsRepo,
    auditRepo: world.auditRepo,
    events: world.events,
    logger: createLogger({ destination: createLogCapture().stream }),
  });
}

describe('statusTransition — placement stage moves', () => {
  let world: FakeWorld;
  let svc: StatusTransitionService;

  beforeEach(async () => {
    world = createFakeWorld();
    svc = makeService(world);
    await world.contactsRepo.create({ contactId: 'tenant-1', type: 'tenant', rta_in_hand: true });
    await world.unitsRepo.create({ unitId: 'unit-1', landlordId: 'll-1', status: 'available' });
  });

  it('stamps stage + stage_entered_at + stage_source and writes a {actor,from,to,source} audit', async () => {
    const c = await world.casesRepo.create({ tenantId: 'tenant-1', unitId: 'unit-1', stage: 'send_application' });
    const updated = await svc.transitionPlacement(c.caseId, { toStage: 'collect_rta', source: 'manual', actor: 'usr_va' });
    expect(updated.stage).toBe('collect_rta');
    expect(typeof updated.stage_entered_at).toBe('string');
    expect(updated.stage_source).toBe('manual');

    const audit = world.auditEvents.find((a) => a.event_type === 'case_stage_changed');
    expect(audit).toBeDefined();
    // The actor (userId) is carried so the byActor GSI indexes status changes (§8).
    expect(audit!.payload).toMatchObject({ actor: 'usr_va', from: 'send_application', to: 'collect_rta', source: 'manual' });
    expect(audit!.entityKey).toBe(`cases#${c.caseId}`);
  });

  it('404s an unknown case and rejects a bad stage', async () => {
    await expect(svc.transitionPlacement('case-ghost', { toStage: 'collect_rta', source: 'manual' })).rejects.toBeInstanceOf(EntityNotFoundError);
    const c = await world.casesRepo.create({ tenantId: 'tenant-1', unitId: 'unit-1', stage: 'send_application' });
    // @ts-expect-error — exercising the runtime guard with a junk stage.
    await expect(svc.transitionPlacement(c.caseId, { toStage: 'bogus', source: 'manual' })).rejects.toBeInstanceOf(TransitionRefusedError);
  });
});

describe('statusTransition — derivation (§7)', () => {
  let world: FakeWorld;
  let svc: StatusTransitionService;

  beforeEach(async () => {
    world = createFakeWorld();
    svc = makeService(world);
    await world.contactsRepo.create({ contactId: 'tenant-1', type: 'tenant', rta_in_hand: true });
    await world.unitsRepo.create({ unitId: 'unit-1', landlordId: 'll-1', status: 'available' });
  });

  const seed = () => world.casesRepo.create({ tenantId: 'tenant-1', unitId: 'unit-1', stage: 'send_application' });

  it('Application phase ⇒ tenant placing / listing under_application', async () => {
    const c = await seed();
    await svc.transitionPlacement(c.caseId, { toStage: 'awaiting_approval', source: 'manual' });
    expect((await world.contactsRepo.getById('tenant-1'))!.status).toBe('placing');
    expect((await world.unitsRepo.getById('unit-1'))!.status).toBe('under_application');
  });

  it('Contract phase ⇒ listing finalizing (tenant still placing)', async () => {
    const c = await seed();
    await svc.transitionPlacement(c.caseId, { toStage: 'awaiting_hap_contract', source: 'manual' });
    expect((await world.contactsRepo.getById('tenant-1'))!.status).toBe('placing');
    expect((await world.unitsRepo.getById('unit-1'))!.status).toBe('finalizing');
  });

  it('moved_in ⇒ tenant placed / listing occupied', async () => {
    const c = await seed();
    await svc.transitionPlacement(c.caseId, { toStage: 'moved_in', source: 'manual' });
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
    await world.contactsRepo.create({ contactId: 'tenant-1', type: 'tenant', rta_in_hand: true });
    await world.unitsRepo.create({ unitId: 'unit-1', landlordId: 'll-1', status: 'available' });
  });

  it('derivation OVERWRITES a manually-set BASELINE listing status (the previously-broken case)', async () => {
    // Staff publish the listing by manually moving it to `available` (source
    // 'manual') — a BASELINE state. The OLD source-precedence rule pinned it and
    // blocked the placement from ever deriving it forward, so the listing stayed
    // publicly shareable while under application. New rule: baseline states are
    // derivation-eligible, so the placement drives it to under_application.
    await svc.setListingStatus('unit-1', { toStatus: 'available', source: 'manual' });
    const c = await world.casesRepo.create({ tenantId: 'tenant-1', unitId: 'unit-1', stage: 'send_application' });
    await svc.transitionPlacement(c.caseId, { toStage: 'awaiting_approval', source: 'manual' });
    const unit = await world.unitsRepo.getById('unit-1');
    expect(unit!.status).toBe('under_application'); // derived forward despite the manual 'available'
    expect(unit!.status_source).toBe('derived');
  });

  it('derivation OVERWRITES a manually-set BASELINE tenant status (searching → placing)', async () => {
    await svc.setTenantStatus('tenant-1', { toStatus: 'searching', source: 'manual' });
    const c = await world.casesRepo.create({ tenantId: 'tenant-1', unitId: 'unit-1', stage: 'send_application' });
    await svc.transitionPlacement(c.caseId, { toStage: 'awaiting_approval', source: 'manual' });
    const contact = await world.contactsRepo.getById('tenant-1');
    expect(contact!.status).toBe('placing'); // derived forward despite the manual 'searching'
    expect(contact!.status_source).toBe('derived');
  });

  it('derivation does NOT overwrite an OVERRIDE listing status (on_hold / off_market stay pinned)', async () => {
    for (const override of ['on_hold', 'off_market'] as const) {
      const world2 = createFakeWorld();
      const svc2 = makeService(world2);
      await world2.contactsRepo.create({ contactId: 'tenant-1', type: 'tenant', rta_in_hand: true });
      await world2.unitsRepo.create({ unitId: 'unit-1', landlordId: 'll-1', status: 'available' });
      await svc2.setListingStatus('unit-1', { toStatus: override, source: 'manual' });
      const c = await world2.casesRepo.create({ tenantId: 'tenant-1', unitId: 'unit-1', stage: 'send_application' });
      await svc2.transitionPlacement(c.caseId, { toStage: 'awaiting_approval', source: 'manual' });
      const unit = await world2.unitsRepo.getById('unit-1');
      expect(unit!.status, override).toBe(override); // override preserved
      expect(unit!.status_source, override).toBe('manual');
    }
  });

  it('derivation does NOT overwrite an OVERRIDE tenant status (on_hold / inactive stay pinned)', async () => {
    for (const override of ['on_hold', 'inactive'] as const) {
      const world2 = createFakeWorld();
      const svc2 = makeService(world2);
      await world2.contactsRepo.create({ contactId: 'tenant-1', type: 'tenant', rta_in_hand: true });
      await world2.unitsRepo.create({ unitId: 'unit-1', landlordId: 'll-1', status: 'available' });
      await svc2.setTenantStatus('tenant-1', { toStatus: override, source: 'manual' });
      const c = await world2.casesRepo.create({ tenantId: 'tenant-1', unitId: 'unit-1', stage: 'send_application' });
      await svc2.transitionPlacement(c.caseId, { toStage: 'awaiting_approval', source: 'manual' });
      const contact = await world2.contactsRepo.getById('tenant-1');
      expect(contact!.status, override).toBe(override); // override preserved
      expect(contact!.status_source, override).toBe('manual');
    }
  });

  it('moving a listing OUT of an override (on_hold → available) re-enables derivation', async () => {
    await svc.setListingStatus('unit-1', { toStatus: 'on_hold', source: 'manual' });
    const c = await world.casesRepo.create({ tenantId: 'tenant-1', unitId: 'unit-1', stage: 'send_application' });
    // While on_hold, the placement transition does NOT derive it forward.
    await svc.transitionPlacement(c.caseId, { toStage: 'awaiting_approval', source: 'manual' });
    expect((await world.unitsRepo.getById('unit-1'))!.status).toBe('on_hold');
    // A human moves it back OUT of the override (explicit write always applies).
    await svc.setListingStatus('unit-1', { toStatus: 'available', source: 'manual' });
    // A subsequent placement transition now derives it forward.
    await svc.transitionPlacement(c.caseId, { toStage: 'awaiting_hap_contract', source: 'manual' });
    const unit = await world.unitsRepo.getById('unit-1');
    expect(unit!.status).toBe('finalizing');
    expect(unit!.status_source).toBe('derived');
  });

  it('a manually on_hold tenant on a moved_in placement STAYS on_hold (derivation skipped)', async () => {
    await svc.setTenantStatus('tenant-1', { toStatus: 'on_hold', source: 'manual' });
    const c = await world.casesRepo.create({ tenantId: 'tenant-1', unitId: 'unit-1', stage: 'awaiting_move_in' });
    // moved_in would derive tenant→placed / listing→occupied, but on_hold pins.
    await svc.transitionPlacement(c.caseId, { toStage: 'moved_in', source: 'manual' });
    expect((await world.contactsRepo.getById('tenant-1'))!.status).toBe('on_hold'); // pinned
    // The (baseline 'available') listing is NOT pinned, so it derives to occupied.
    expect((await world.unitsRepo.getById('unit-1'))!.status).toBe('occupied');
  });

  it('an explicit (non-derived) write always applies — moving INTO an override over a derived value', async () => {
    const c = await world.casesRepo.create({ tenantId: 'tenant-1', unitId: 'unit-1', stage: 'send_application' });
    await svc.transitionPlacement(c.caseId, { toStage: 'awaiting_approval', source: 'manual' });
    expect((await world.unitsRepo.getById('unit-1'))!.status).toBe('under_application'); // derived

    await svc.setListingStatus('unit-1', { toStatus: 'on_hold', source: 'manual' });
    const unit = await world.unitsRepo.getById('unit-1');
    expect(unit!.status).toBe('on_hold'); // explicit write applies unconditionally
    expect(unit!.status_source).toBe('manual');
  });
});

describe('statusTransition — tenant status + RTA-in-hand gate (§5)', () => {
  let world: FakeWorld;
  let svc: StatusTransitionService;

  beforeEach(() => {
    world = createFakeWorld();
    svc = makeService(world);
  });

  it('→searching is REFUSED when rta_in_hand !== true', async () => {
    await world.contactsRepo.create({ contactId: 't-no-rta', type: 'tenant', rta_in_hand: false });
    await expect(
      svc.setTenantStatus('t-no-rta', { toStatus: 'searching', source: 'manual' }),
    ).rejects.toMatchObject({ code: 'rta_gate' });
  });

  it('→searching is REFUSED when porting === true (even with rta_in_hand)', async () => {
    await world.contactsRepo.create({ contactId: 't-port', type: 'tenant', rta_in_hand: true, porting: true });
    await expect(
      svc.setTenantStatus('t-port', { toStatus: 'searching', source: 'manual' }),
    ).rejects.toMatchObject({ code: 'rta_gate' });
    // Clearing porting in the SAME call lets it through.
    const ok = await svc.setTenantStatus('t-port', { toStatus: 'searching', source: 'manual', porting: false });
    expect(ok.status).toBe('searching');
    expect(ok.porting).toBe(false);
  });

  it('→searching is ALLOWED when rta_in_hand && !porting; audits {from,to,source}', async () => {
    await world.contactsRepo.create({ contactId: 't-ok', type: 'tenant', rta_in_hand: true, status: 'onboarding' });
    const updated = await svc.setTenantStatus('t-ok', { toStatus: 'searching', source: 'manual' });
    expect(updated.status).toBe('searching');
    expect(updated.status_source).toBe('manual');
    const audit = world.auditEvents.find((a) => a.event_type === 'tenant_status_changed');
    expect(audit!.payload).toMatchObject({ from: 'onboarding', to: 'searching', source: 'manual' });
  });

  it('manual drop-out to inactive is allowed (no gate); porting is a flag, never a stage', async () => {
    await world.contactsRepo.create({ contactId: 't-drop', type: 'tenant', rta_in_hand: true });
    const updated = await svc.setTenantStatus('t-drop', { toStatus: 'inactive', source: 'manual' });
    expect(updated.status).toBe('inactive');
    // porting lives on the contact, never appears as a case stage.
    expect(updated).not.toHaveProperty('stage');
  });
});

describe('statusTransition — final_rent on rent acceptance (§4)', () => {
  it('does NOT write final_rent when ENTERING awaiting_rent_acceptance', async () => {
    const world = createFakeWorld();
    const svc = makeService(world);
    await world.contactsRepo.create({ contactId: 'tenant-1', type: 'tenant', rta_in_hand: true });
    await world.unitsRepo.create({ unitId: 'unit-1', landlordId: 'll-1', status: 'available' });
    const c = await world.casesRepo.create({ tenantId: 'tenant-1', unitId: 'unit-1', stage: 'determine_rent' });
    // Entering awaiting_rent_acceptance is the "still awaiting acceptance" state —
    // the rent is not yet accepted, so nothing is written even if finalRent leaks in.
    await svc.transitionPlacement(c.caseId, { toStage: 'awaiting_rent_acceptance', source: 'manual', finalRent: 1825 });
    expect((await world.unitsRepo.getById('unit-1'))!.final_rent).toBeUndefined();
  });

  it('writes final_rent onto the unit when LEAVING awaiting_rent_acceptance (the accept move)', async () => {
    const world = createFakeWorld();
    const svc = makeService(world);
    await world.contactsRepo.create({ contactId: 'tenant-1', type: 'tenant', rta_in_hand: true });
    await world.unitsRepo.create({ unitId: 'unit-1', landlordId: 'll-1', status: 'available' });
    const c = await world.casesRepo.create({ tenantId: 'tenant-1', unitId: 'unit-1', stage: 'awaiting_rent_acceptance' });
    // The landlord accepts → move OUT of awaiting_rent_acceptance, carrying the
    // accepted amount → final_rent lands on the unit (§4).
    await svc.transitionPlacement(c.caseId, { toStage: 'awaiting_hap_contract', source: 'manual', finalRent: 1825 });
    expect((await world.unitsRepo.getById('unit-1'))!.final_rent).toBe(1825);
  });

  it('does NOT write final_rent when LEAVING awaiting_rent_acceptance for the TERMINAL `lost` (a dying deal is not an acceptance)', async () => {
    const world = createFakeWorld();
    const svc = makeService(world);
    await world.contactsRepo.create({ contactId: 'tenant-1', type: 'tenant', rta_in_hand: true });
    await world.unitsRepo.create({ unitId: 'unit-1', landlordId: 'll-1', status: 'available' });
    const c = await world.casesRepo.create({ tenantId: 'tenant-1', unitId: 'unit-1', stage: 'awaiting_rent_acceptance' });
    // awaiting_rent_acceptance → lost is the deal dying, NOT a rent acceptance,
    // so final_rent must never be stamped onto the unit even if a stray
    // finalRent rides along on the move (edge guard #5).
    await svc.transitionPlacement(c.caseId, {
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
    await world.contactsRepo.create({ contactId: 'tenant-1', type: 'tenant', rta_in_hand: true });
    await world.unitsRepo.create({ unitId: 'unit-1', landlordId: 'll-1', status: 'available' });
  });

  it('stores the structured {category,text} reason and bounces tenant→searching / listing→available when no other active placement', async () => {
    const c = await world.casesRepo.create({ tenantId: 'tenant-1', unitId: 'unit-1', stage: 'awaiting_inspection' });
    const updated = await svc.transitionPlacement(c.caseId, {
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
    const c = await world.casesRepo.create({ tenantId: 'tenant-1', unitId: 'unit-1', stage: 'awaiting_inspection' });
    await svc.transitionPlacement(c.caseId, { toStage: 'lost', source: 'manual', lostReason: { category: 'stalled' } });
    expect((await world.contactsRepo.getById('tenant-1'))!.status).toBe('on_hold'); // pinned, no bounce
    // The listing (baseline 'available') is not pinned, so it bounces to available.
    expect((await world.unitsRepo.getById('unit-1'))!.status).toBe('available');
  });

  it('does NOT bounce when ANOTHER active placement exists on the tenant/unit', async () => {
    // Two placements for the same tenant on the same unit; one stays active.
    const active = await world.casesRepo.create({ tenantId: 'tenant-1', unitId: 'unit-1', stage: 'awaiting_approval' });
    // Drive the active one's derivation so tenant=placing / listing=under_application.
    await svc.transitionPlacement(active.caseId, { toStage: 'awaiting_approval', source: 'manual' });
    const losing = await world.casesRepo.create({ tenantId: 'tenant-1', unitId: 'unit-1', stage: 'awaiting_inspection' });
    await svc.transitionPlacement(losing.caseId, { toStage: 'lost', source: 'manual', lostReason: { category: 'stalled' } });
    // The OTHER placement is still active → no bounce-back.
    expect((await world.contactsRepo.getById('tenant-1'))!.status).toBe('placing');
    expect((await world.unitsRepo.getById('unit-1'))!.status).toBe('under_application');
  });
});

describe('statusTransition — time-in-stage stuck nudge (§8)', () => {
  let world: FakeWorld;
  let svc: StatusTransitionService;

  beforeEach(async () => {
    world = createFakeWorld();
    svc = makeService(world);
    await world.contactsRepo.create({ contactId: 'tenant-1', type: 'tenant', rta_in_hand: true });
    await world.unitsRepo.create({ unitId: 'unit-1', landlordId: 'll-1', status: 'available' });
  });

  it('sets a stuck_case next-deadline at ~now + the stage threshold', async () => {
    const c = await world.casesRepo.create({ tenantId: 'tenant-1', unitId: 'unit-1', stage: 'send_application' });
    const before = Date.now();
    const updated = await svc.transitionPlacement(c.caseId, { toStage: 'awaiting_hap_contract', source: 'manual' });
    expect(updated.next_deadline_type).toBe('stuck_case');
    const at = Date.parse(updated.next_deadline_at!);
    const expected = before + STAGE_STUCK_THRESHOLDS.awaiting_hap_contract!;
    // Within a generous window (scheduling computes now+threshold).
    expect(at).toBeGreaterThanOrEqual(expected - 5_000);
    expect(at).toBeLessThanOrEqual(Date.now() + STAGE_STUCK_THRESHOLDS.awaiting_hap_contract! + 5_000);
  });

  it('does NOT clobber a pending HARD-CLOCK deadline (rta_window) with a stuck nudge', async () => {
    const c = await world.casesRepo.create({ tenantId: 'tenant-1', unitId: 'unit-1', stage: 'collect_rta' });
    await world.casesRepo.setNextDeadline(c.caseId, { type: 'rta_window', at: '2026-09-01T00:00:00.000Z' });
    await svc.transitionPlacement(c.caseId, { toStage: 'review_rta', source: 'manual' });
    const after = await world.casesRepo.getById(c.caseId);
    expect(after!.next_deadline_type).toBe('rta_window'); // untouched
    expect(after!.next_deadline_at).toBe('2026-09-01T00:00:00.000Z');
  });

  it('a terminal stage clears a pending stuck nudge', async () => {
    const c = await world.casesRepo.create({ tenantId: 'tenant-1', unitId: 'unit-1', stage: 'send_application' });
    await svc.transitionPlacement(c.caseId, { toStage: 'awaiting_approval', source: 'manual' });
    expect((await world.casesRepo.getById(c.caseId))!.next_deadline_type).toBe('stuck_case');
    await svc.transitionPlacement(c.caseId, { toStage: 'lost', source: 'manual', lostReason: { category: 'no_contact' } });
    const after = await world.casesRepo.getById(c.caseId);
    expect(after!.next_deadline_type).toBeUndefined();
    expect(after!.next_deadline_at).toBeUndefined();
  });

  it('a terminal stage clears a pending HARD-CLOCK deadline too (closed placement → slot moot)', async () => {
    const c = await world.casesRepo.create({ tenantId: 'tenant-1', unitId: 'unit-1', stage: 'collect_rta' });
    // A hard-clock rta_window deadline holds the single slot.
    await world.casesRepo.setNextDeadline(c.caseId, { type: 'rta_window', at: '2026-09-01T00:00:00.000Z' });
    // Going terminal must clear it — a closed deal never fires a deadline nudge.
    await svc.transitionPlacement(c.caseId, { toStage: 'moved_in', source: 'manual' });
    const after = await world.casesRepo.getById(c.caseId);
    expect(after!.next_deadline_type).toBeUndefined();
    expect(after!.next_deadline_at).toBeUndefined();
  });
});
