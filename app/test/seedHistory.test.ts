// Coverage for the FULL-profile lifecycle-history post-pass (app/src/lib/seed/history.ts).
//
// The clean-slate seed sets every entity to its END state but wrote almost no
// lifecycle *history*, so three dashboard history surfaces render blank. This
// suite pins the deterministic generator that materializes the missing AUDIT
// trails (placement stage trails + derived tenant/unit side-effects + standalone
// tenant/landlord/unit status trails) — and proves the LEAN profile is never
// touched (its byte-stable world is the load-bearing e2e/reseed regression gate).
//
// Pure-generator assertions run with NO Docker. A single DB-backed test
// (skipIf-guarded) proves a real seedAll(_, 'full') completes and the pinned
// placement reads back as a coherent trail via auditRepo.listByEntity.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PLACEMENT_STAGES,
  TENANT_STATUSES,
  LANDLORD_STATUSES,
  LISTING_STATUSES,
  STAGE_LABELS,
  TERMINAL_STAGES,
  type PlacementStage,
} from '../src/lib/statusModel.js';
import { TOUR_STATUS_LABELS } from '../src/lib/toursModel.js';
import { createDynamoClient } from '../src/lib/dynamo.js';
import { deleteTableIfExists, ensureTable } from '../src/lib/dynamoAdmin.js';
import { TABLES } from '../src/lib/tables.js';
import { SEED } from '../src/lib/seed/lean.js';
import { castItems } from '../src/lib/seed/cast.js';
import { matrixItems } from '../src/lib/seed/matrix.js';
import {
  historyItems,
  placementHistory,
  standaloneContactHistory,
  standaloneUnitHistory,
  entityHistory,
  placementMilestones,
  tourMilestones,
  listingSendMilestones,
  contactPhoneMilestones,
  LIFECYCLE_EVENT_TYPES,
  type AuditRow,
  type ActivityRow,
} from '../src/lib/seed/history.js';

// --- helpers ----------------------------------------------------------------
const iso = (ts: string) => ts.split('#')[0]!;
const isoList = (rows: AuditRow[]) => rows.map((r) => iso(r.ts));
const strictlyIncreasing = (xs: string[]) => xs.every((x, i) => i === 0 || xs[i - 1]! < x);

// matrixItems() is now-relative (Task 1): every call defaults to `new Date()`.
// Pass a FIXED clock so buildFullTables() is deterministic across calls — the
// byte-stability assertions below compare two independent builds.
const FIXED_NOW = new Date('2026-07-03T12:00:00.000Z');

/** Build the FULL item map the way seedAll('full') does (lean + cast + matrix). */
function buildFullTables(): Record<string, Record<string, unknown>[]> {
  const tables: Record<string, Record<string, unknown>[]> = {};
  for (const [base, items] of Object.entries(SEED)) tables[base] = [...items];
  for (const [base, items] of Object.entries(castItems())) tables[base] = [...(tables[base] ?? []), ...items];
  for (const [base, items] of Object.entries(matrixItems(FIXED_NOW))) tables[base] = [...(tables[base] ?? []), ...items];
  return tables;
}

const FULL = buildFullTables();
const PLACEMENTS = FULL['placements'] ?? [];
const CONTACTS = FULL['contacts'] ?? [];
const UNITS = FULL['units'] ?? [];

const stageIdx = (s: string) => PLACEMENT_STAGES.indexOf(s as PlacementStage);

describe('seed history — placement audit trails', () => {
  it('every non-start, non-terminal placement trail is its slice(0, idx+1) consecutive-pair sequence', () => {
    const nonStart = PLACEMENTS.filter((p) => {
      const s = String(p['stage']);
      return s !== 'send_application' && s !== 'lost';
    });
    expect(nonStart.length).toBeGreaterThan(0);
    for (const p of nonStart) {
      const stage = String(p['stage']) as PlacementStage;
      const idx = stageIdx(stage);
      const rows = placementHistory(p).filter((r) => r.event_type === 'placement_stage_changed');
      const expectedStages = PLACEMENT_STAGES.slice(0, idx + 1);
      // one hop per consecutive pair
      expect(rows.length).toBe(expectedStages.length - 1);
      rows.forEach((r, k) => {
        expect(r.payload['from']).toBe(expectedStages[k]);
        expect(r.payload['to']).toBe(expectedStages[k + 1]);
        expect(r.payload['source']).toBe('manual');
        expect(r.actorId).toBe('user-0001'); // hoisted from payload.actor
        expect(r.entityKey).toBe(`placements#${p['placementId']}`);
      });
      // oldest-first + strictly increasing, anchored to stage_entered_at
      const isos = isoList(rows);
      expect(strictlyIncreasing(isos)).toBe(true);
      expect(isos[isos.length - 1]).toBe(iso(String(p['stage_entered_at'])));
    }
  });

  it('a send_application placement has ZERO placement_stage_changed rows (at start)', () => {
    const start = PLACEMENTS.find((p) => p['stage'] === 'send_application');
    expect(start).toBeDefined();
    const rows = placementHistory(start!).filter((r) => r.event_type === 'placement_stage_changed');
    expect(rows.length).toBe(0);
  });

  it('lost placements walk an active prefix then → lost with lost_reason_category on the final hop', () => {
    const lost = PLACEMENTS.filter((p) => p['stage'] === 'lost');
    expect(lost.length).toBeGreaterThan(0);
    for (const p of lost) {
      const rows = placementHistory(p).filter((r) => r.event_type === 'placement_stage_changed');
      const final = rows[rows.length - 1]!;
      expect(final.payload['to']).toBe('lost');
      // the prefix is consecutive active stages starting at send_application
      expect(rows[0]!.payload['from']).toBe('send_application');
      for (let k = 0; k < rows.length - 1; k++) {
        expect(rows[k]!.payload['to']).toBe(rows[k + 1]!.payload['from']);
        expect(rows[k]!.payload['to']).not.toBe('lost');
      }
      const cat = (p['lost_reason'] as Record<string, unknown> | undefined)?.['category'];
      if (cat !== undefined) expect(final.payload['lost_reason_category']).toBe(cat);
      expect(strictlyIncreasing(isoList(rows))).toBe(true);
      expect(iso(final.ts)).toBe(iso(String(p['stage_entered_at'])));
    }
  });
});

describe('seed history — derived tenant/unit side-effects', () => {
  it('derived rows appear exactly where deriveStatuses flips and share a placement stage-entry timestamp', () => {
    for (const p of PLACEMENTS) {
      const rows = placementHistory(p);
      // The set of PLACEMENT-STAGE-ENTRY timestamps (the `placement_stage_changed`
      // hop instants) — deliberately NOT including the derived rows themselves, so
      // membership below is a real constraint (proving derived rows are slaved to the
      // placement clock, not vacuously true because the row is in its own set).
      const placementIsos = new Set(
        rows.filter((r) => r.event_type === 'placement_stage_changed').map((r) => iso(r.ts)),
      );
      // The create-instant derived flips (baseline needs_review/available → the first
      // stage's derivation) anchor at the walk's oldest instant — strictly older than
      // every hop, so no `placement_stage_changed` row records it. Both the tenant and
      // the unit create rows independently land there; take that shared oldest instant
      // as the create-entry timestamp (independent of any single row under test).
      const derivedTenant = rows.filter((r) => r.event_type === 'tenant_status_changed');
      const derivedUnit = rows.filter(
        (r) => r.event_type === 'listing_status_changed' && r.payload['source'] === 'derived',
      );
      const derivedIsos = [...derivedTenant, ...derivedUnit].map((r) => iso(r.ts));
      const createIso = derivedIsos.length ? derivedIsos.reduce((a, b) => (a < b ? a : b)) : undefined;
      // A derived row shares EITHER a stage-entry hop timestamp OR the create instant.
      const stageEntryIsos = new Set(placementIsos);
      if (createIso !== undefined) stageEntryIsos.add(createIso);
      for (const r of [...derivedTenant, ...derivedUnit]) {
        expect(r.payload['source']).toBe('derived');
        expect(r.actorId).toBeUndefined(); // derived rows carry NO actor
        expect(stageEntryIsos.has(iso(r.ts))).toBe(true);
      }
      // final tenant/unit derived status equals the stored end state
      const tenant = CONTACTS.find((c) => c['contactId'] === p['tenantId']);
      const unit = UNITS.find((u) => u['unitId'] === p['unitId']);
      if (derivedTenant.length > 0 && tenant) {
        expect(derivedTenant[derivedTenant.length - 1]!.payload['to']).toBe(tenant['status']);
      }
      if (unit) {
        const lastUnitDerived = derivedUnit[derivedUnit.length - 1];
        if (lastUnitDerived) expect(lastUnitDerived.payload['to']).toBe(unit['status']);
      }
      // suppress unused
      void placementIsos;
    }
  });

  it('every placement-linked unit past setup gets a setup → available publish hop (manual)', () => {
    for (const p of PLACEMENTS) {
      const rows = placementHistory(p).filter((r) => r.entityKey === `units#${p['unitId']}`);
      const publish = rows.find(
        (r) => r.payload['from'] === 'setup' && r.payload['to'] === 'available',
      );
      expect(publish, `unit ${p['unitId']} publish hop`).toBeDefined();
      expect(publish!.payload['source']).toBe('manual');
      expect(publish!.actorId).toBe('user-0001');
      expect(publish!.event_type).toBe('listing_status_changed');
    }
  });
});

describe('seed history — standalone contact status trails', () => {
  it('every standalone tenant past needs_review has a tenant_status_changed ladder anchored at created_at', () => {
    const placementTenantIds = new Set(PLACEMENTS.map((p) => p['tenantId']));
    const standaloneTenants = CONTACTS.filter(
      (c) => c['type'] === 'tenant' && !placementTenantIds.has(c['contactId']) && c['status'] !== 'needs_review',
    );
    expect(standaloneTenants.length).toBeGreaterThan(0);
    for (const c of standaloneTenants) {
      const rows = standaloneContactHistory(c);
      expect(rows.length).toBeGreaterThan(0);
      for (const r of rows) {
        expect(r.event_type).toBe('tenant_status_changed');
        expect(r.entityKey).toBe(`contacts#${c['contactId']}`);
      }
      // ladder starts at needs_review and ends at the stored status
      expect(rows[0]!.payload['from']).toBe('needs_review');
      expect(rows[rows.length - 1]!.payload['to']).toBe(c['status']);
      expect(strictlyIncreasing(isoList(rows))).toBe(true);
      // anchor is `consent_at ?? created_at` (setTenantStatus's clock) — assert against
      // that, not bare created_at, so it stays correct if fixtures diverge the two.
      expect(iso(rows[rows.length - 1]!.ts)).toBe(iso(String(c['consent_at'] ?? c['created_at'])));
      // TENANT_STATUSES membership sanity
      expect(TENANT_STATUSES as readonly string[]).toContain(c['status']);
    }
  });

  it('every standalone landlord past needs_review has a tenant_status_changed ladder (matches the real setTenantStatus event_type)', () => {
    const landlords = CONTACTS.filter((c) => c['type'] === 'landlord' && c['status'] !== 'needs_review');
    expect(landlords.length).toBeGreaterThan(0);
    for (const c of landlords) {
      const rows = standaloneContactHistory(c);
      expect(rows.length).toBeGreaterThan(0);
      for (const r of rows) {
        // FINDING: the landlord status write path is the shared setTenantStatus
        // setter → event_type 'tenant_status_changed' (NOT contact_updated).
        expect(r.event_type).toBe('tenant_status_changed');
        expect(r.payload['source']).toBe('manual');
        expect(r.actorId).toBe('user-0001');
      }
      expect(rows[rows.length - 1]!.payload['to']).toBe(c['status']);
      expect(LANDLORD_STATUSES as readonly string[]).toContain(c['status']);
    }
  });

  it('a parked landlord carries the park reason as `reason` on the final hop (faithful setTenantStatus shape)', () => {
    const parked = CONTACTS.find(
      (c) => c['type'] === 'landlord' && c['status'] === 'parked' && typeof c['park_reason'] === 'string',
    );
    expect(parked).toBeDefined();
    const rows = standaloneContactHistory(parked!);
    const final = rows[rows.length - 1]!;
    expect(final.payload['to']).toBe('parked');
    expect(final.payload['reason']).toBe(parked!['park_reason']);
  });
});

describe('seed history — standalone unit status trails', () => {
  it('an available-only (non-placement) unit gets exactly one setup → available publish row', () => {
    const placementUnitIds = new Set(PLACEMENTS.map((p) => p['unitId']));
    const availableOnly = UNITS.filter(
      (u) => u['status'] === 'available' && !placementUnitIds.has(u['unitId']),
    );
    expect(availableOnly.length).toBeGreaterThan(0);
    for (const u of availableOnly) {
      const rows = standaloneUnitHistory(u);
      expect(rows.length).toBe(1);
      expect(rows[0]!.payload['from']).toBe('setup');
      expect(rows[0]!.payload['to']).toBe('available');
      expect(rows[0]!.payload['source']).toBe('manual');
    }
  });

  it('a setup unit (at start) gets no trail', () => {
    const setupUnit = UNITS.find((u) => u['status'] === 'setup');
    if (setupUnit) expect(standaloneUnitHistory(setupUnit).length).toBe(0);
  });

  it('an override (on_hold/off_market) standalone unit shows publish then a manual override branch', () => {
    const placementUnitIds = new Set(PLACEMENTS.map((p) => p['unitId']));
    const override = UNITS.filter(
      (u) => (u['status'] === 'on_hold' || u['status'] === 'off_market') && !placementUnitIds.has(u['unitId']),
    );
    expect(override.length).toBeGreaterThan(0);
    for (const u of override) {
      const rows = standaloneUnitHistory(u);
      expect(rows[0]!.payload['to']).toBe('available'); // publish first
      const final = rows[rows.length - 1]!;
      expect(final.payload['to']).toBe(u['status']);
      expect(final.payload['source']).toBe('manual');
      expect(LISTING_STATUSES as readonly string[]).toContain(u['status']);
    }
  });
});

describe('seed history — orchestrator + dedupe (single source of truth §4.7)', () => {
  const result = historyItems(FULL);

  it('supersedes pre-existing lifecycle rows but keeps non-lifecycle rows (lean contact.profile_edited)', () => {
    const pre = SEED['audit_events'] ?? [];
    // the pre-existing single lean placement_stage_changed row is a lifecycle class → superseded
    expect(pre.some((r) => r['event_type'] === 'placement_stage_changed')).toBe(true);
    // no DUPLICATE pre-existing lifecycle rows survive: placements#placement-0001 now has a FULL trail
    const leanPlacementRows = result.audit_events.filter(
      (r) => r.entityKey === 'placements#placement-0001' && r.event_type === 'placement_stage_changed',
    );
    expect(leanPlacementRows.length).toBe(stageIdx('awaiting_inspection')); // 10 hops
    // the non-lifecycle profile_edited row is preserved verbatim
    expect(
      result.audit_events.some((r) => r.event_type === 'contact.profile_edited'),
    ).toBe(true);
  });

  it('produces NO pre-existing lifecycle rows verbatim (all lifecycle rows are generated)', () => {
    expect(LIFECYCLE_EVENT_TYPES.has('placement_stage_changed')).toBe(true);
    // the exact lean single-hop row (send_rta_to_landlord → awaiting_inspection at bare T2) is gone
    const stray = result.audit_events.find(
      (r) =>
        r.entityKey === 'placements#placement-0001' &&
        r.payload?.['from'] === 'send_rta_to_landlord' &&
        r.ts === '2026-06-01T14:05:45.000Z', // the bare-ISO lean SK (generated rows are <ISO>#<suffix>)
    );
    expect(stray).toBeUndefined();
  });

  it('preserves a pre-existing lifecycle row on an entity the generator produces NO rows for, but drops it for a regenerated entity', () => {
    // Entity-scoped dedupe: a hand-authored lifecycle row must survive when the
    // generator emits nothing for that entityKey (e.g. a contact that ends at
    // needs_review → empty trail), yet still be superseded when the generator DOES
    // regenerate that entity. Non-lifecycle rows are always kept.
    const tables: Record<string, Record<string, unknown>[]> = {
      contacts: [
        // needs_review → generator emits ZERO rows for contacts#ghost-0001
        { contactId: 'ghost-0001', type: 'tenant', status: 'needs_review', created_at: '2026-01-01T00:00:00.000Z' },
        // placing → generator DOES emit a ladder for contacts#active-0001
        { contactId: 'active-0001', type: 'tenant', status: 'placing', created_at: '2026-01-01T00:00:00.000Z' },
      ],
      placements: [],
      units: [],
      audit_events: [
        // hand-authored lifecycle row on the NON-regenerated entity → must be PRESERVED
        {
          entityKey: 'contacts#ghost-0001',
          ts: '2026-02-01T00:00:00.000Z#deadbeef',
          event_type: 'tenant_status_changed',
          payload: { from: 'needs_review', to: 'needs_review', source: 'manual' },
        },
        // hand-authored lifecycle row on the REGENERATED entity → must be DROPPED
        {
          entityKey: 'contacts#active-0001',
          ts: '2026-02-02T00:00:00.000Z#feedface',
          event_type: 'tenant_status_changed',
          payload: { from: 'x', to: 'y', source: 'manual' },
        },
        // non-lifecycle row → always PRESERVED
        {
          entityKey: 'contacts#ghost-0001',
          ts: '2026-02-03T00:00:00.000Z#cafebabe',
          event_type: 'contact.profile_edited',
          payload: {},
        },
      ],
    };
    const out = historyItems(tables);
    // preserved: the ghost's hand-authored lifecycle row survives (generator emitted nothing for it)
    expect(out.audit_events.some((r) => r.ts === '2026-02-01T00:00:00.000Z#deadbeef')).toBe(true);
    // dropped: the regenerated entity's pre-existing lifecycle row is superseded
    expect(out.audit_events.some((r) => r.ts === '2026-02-02T00:00:00.000Z#feedface')).toBe(false);
    // and the generator DID produce a fresh ladder for the regenerated entity
    expect(
      out.audit_events.some((r) => r.entityKey === 'contacts#active-0001' && r.event_type === 'tenant_status_changed'),
    ).toBe(true);
    // non-lifecycle row always preserved
    expect(out.audit_events.some((r) => r.ts === '2026-02-03T00:00:00.000Z#cafebabe')).toBe(true);
  });

  it('activity_events is populated (Task 2) and every row has the stored milestone shape', () => {
    expect(result.activity_events.length).toBeGreaterThan(0);
    for (const r of result.activity_events) {
      expect(typeof r['contactId']).toBe('string');
      expect(String(r['tsEventId'])).toBe(`${r['at']}#${r['eventId']}`);
      expect(String(r['eventId'])).toMatch(/^evt-/);
      expect(typeof r['type']).toBe('string');
      expect(typeof r['label']).toBe('string');
      expect(typeof r['created_at']).toBe('string');
    }
  });

  it('every generated audit SK has the real <ISO>#<suffix> shape', () => {
    for (const r of result.audit_events) {
      if (LIFECYCLE_EVENT_TYPES.has(r.event_type)) {
        expect(r.ts).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z#[0-9a-f]{8}$/);
      }
    }
  });

  it('is byte-stable: two runs produce identical output', () => {
    const a = JSON.stringify(historyItems(buildFullTables()).audit_events);
    const b = JSON.stringify(historyItems(buildFullTables()).audit_events);
    expect(a).toBe(b);
  });

  it('entityHistory dispatches to the per-entity generators (live reuse hook)', () => {
    const p = PLACEMENTS[0]!;
    expect(entityHistory(p, { kind: 'placement' })).toEqual(placementHistory(p));
  });
});

describe('seed history — contact activity milestones (Task 2, §4.6)', () => {
  const result = historyItems(FULL);
  const TOURS = FULL['tours'] ?? [];
  const LISTING_SENDS = FULL['listing_sends'] ?? [];

  const byContact = new Map<string, ActivityRow[]>();
  for (const r of result.activity_events) {
    const list = byContact.get(String(r.contactId)) ?? [];
    list.push(r);
    byContact.set(String(r.contactId), list);
  }

  it('every placement-linked tenant has a non-empty timeline led by placement_opened (faithful writer labels)', () => {
    for (const p of PLACEMENTS) {
      const tenantId = String(p['tenantId']);
      const rows = placementMilestones(p);
      expect(rows.length).toBeGreaterThan(0);
      const opened = rows[0]!;
      expect(opened.type).toBe('placement_opened');
      expect(opened.label).toBe('Placement opened'); // placements.ts:465
      expect(opened.refType).toBe('placement');
      expect(opened.refId).toBe(p['placementId']);
      for (const r of rows) expect(r.contactId).toBe(tenantId);
      // The merged orchestrator surfaces these rows for the tenant.
      expect((byContact.get(tenantId) ?? []).length).toBeGreaterThan(0);
    }
  });

  it('placement milestone `at` values align with the Task-1 audit stage-hop instants (one coherent clock)', () => {
    let sawStageChanged = false;
    let sawClosed = false;
    for (const p of PLACEMENTS) {
      const audit = placementHistory(p).filter((r) => r.event_type === 'placement_stage_changed');
      const hopIsos = new Set(audit.map((r) => iso(r.ts)));
      const derived = placementHistory(p).filter((r) => r.payload['source'] === 'derived');
      const oldestDerivedIso = derived.length
        ? derived.map((r) => iso(r.ts)).reduce((a, b) => (a < b ? a : b))
        : undefined;
      const mile = placementMilestones(p);
      for (const r of mile) {
        const at = iso(r.tsEventId);
        if (r.type === 'placement_opened') {
          // Hop 0 = the create instant. It shares the create-time derived-flip instant
          // (Task-1's oldest derived row) — a concrete tie to the same clock, and it is
          // strictly OLDER than every recorded stage hop for a multi-hop placement.
          if (oldestDerivedIso !== undefined) expect(at).toBe(oldestDerivedIso);
        } else {
          // stage_changed / placement_closed each land exactly on a Task-1 stage-hop instant.
          expect(hopIsos.has(at)).toBe(true);
          if (r.type === 'stage_changed') sawStageChanged = true;
          if (r.type === 'placement_closed') sawClosed = true;
        }
      }
      // Concrete terminal check: a terminal placement's placement_closed lands on the
      // anchor (== newest audit hop).
      const stage = String(p['stage']) as PlacementStage;
      if (TERMINAL_STAGES.has(stage)) {
        const closed = mile.find((r) => r.type === 'placement_closed')!;
        expect(closed).toBeDefined();
        expect(iso(closed.tsEventId)).toBe(iso(String(p['stage_entered_at'])));
        expect(closed.label.startsWith(`Placement closed - ${STAGE_LABELS[stage]}`)).toBe(true);
      }
    }
    // The alignment assertions must have actually run against both hop-milestone kinds.
    expect(sawStageChanged).toBe(true);
    expect(sawClosed).toBe(true);
  });

  it('a stage_changed milestone uses the real "Stage → <label>" writer format', () => {
    const inspection = PLACEMENTS.find((p) => p['stage'] === 'awaiting_inspection');
    expect(inspection).toBeDefined();
    const rows = placementMilestones(inspection!);
    const sc = rows.find((r) => r.type === 'stage_changed' && r.label === `Stage → ${STAGE_LABELS['awaiting_inspection']}`);
    expect(sc).toBeDefined(); // placements.ts:556
    expect(sc!.refType).toBe('placement');
  });

  it('tour_scheduled + tour_took_place are present for a toured tour, keyed on its tenant', () => {
    const toured = TOURS.find((t) => t['status'] === 'toured');
    expect(toured).toBeDefined();
    const rows = tourMilestones(toured!);
    const types = rows.map((r) => r.type);
    expect(types).toContain('tour_scheduled');
    expect(types).toContain('tour_took_place');
    for (const r of rows) expect(r.contactId).toBe(toured!['tenantId']);
    const tookPlace = rows.find((r) => r.type === 'tour_took_place')!;
    // activityEventsRepo.ts:59 documents this exact label shape.
    expect(tookPlace.label).toBe(`Tour took place - ${TOUR_STATUS_LABELS['toured']}`);
    // refType 'tour' → deep-links to the tour itself (mirrors recordTourEvent in
    // routes/tours.ts), not the property.
    expect(tookPlace.refType).toBe('tour');
    expect(tookPlace.refId).toBe(toured!['tourId']);
    expect(iso(tookPlace.tsEventId)).toBe(iso(String(toured!['scheduledAt'])));
    // The merged orchestrator surfaces the tour milestones for the tenant.
    const merged = byContact.get(String(toured!['tenantId'])) ?? [];
    expect(merged.some((r) => r.type === 'tour_took_place')).toBe(true);
  });

  it('a requested (timeless) tour yields NO milestones', () => {
    const requested = TOURS.find((t) => t['status'] === 'requested');
    if (requested) expect(tourMilestones(requested).length).toBe(0);
  });

  it('listing_sends produce a faithful listing_sent milestone (no response label)', () => {
    const send = LISTING_SENDS[0];
    expect(send).toBeDefined();
    const rows = listingSendMilestones(send!);
    const sent = rows.find((r) => r.type === 'listing_sent')!;
    expect(sent.label).toBe('Property sent'); // broadcastFanOut.ts:309
    expect(sent.refType).toBe('unit');
    expect(sent.refId).toBe(send!['unitId']);
    expect(iso(sent.tsEventId)).toBe(iso(String(send!['sentAt'])));
    // The removed `response` label yields NO listing_reviewed milestone anymore.
    for (const s of LISTING_SENDS) {
      expect(listingSendMilestones(s).some((r) => r.type === 'listing_reviewed')).toBe(false);
    }
  });

  it('a multi-phone contact emits a number_added milestone per non-primary number', () => {
    const multi = CONTACTS.find(
      (c) => Array.isArray(c['phones']) && (c['phones'] as unknown[]).length > 1,
    );
    expect(multi).toBeDefined();
    const rows = contactPhoneMilestones(multi!);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.type).toBe('number_added');
      expect(r.label).toBe('Number added'); // contacts.ts:1473
      expect(r.refType).toBeUndefined();
      expect(r.contactId).toBe(multi!['contactId']);
    }
  });

  it('two non-primary phones sharing a firstSeenAt yield DISTINCT number_added rows (no id collision)', () => {
    // Synthetic contact: two NON-primary phones added at the SAME instant. Without
    // the per-phone salt both rows hash to one eventId → identical tsEventId/PK+SK →
    // one silently overwrites the other on Put. Assert both survive as distinct rows.
    const sameInstant = '2026-05-01T00:00:00.000Z';
    const contact = {
      contactId: 'contact-collide-01',
      type: 'tenant',
      status: 'searching',
      created_at: '2026-04-01T00:00:00.000Z',
      phones: [
        { phone: '+15550190001', primary: true, firstSeenAt: '2026-04-01T00:00:00.000Z' },
        { phone: '+15550190002', primary: false, firstSeenAt: sameInstant },
        { phone: '+15550190003', primary: false, firstSeenAt: sameInstant },
      ],
    };
    const rows = contactPhoneMilestones(contact);
    expect(rows.length).toBe(2); // one per NON-primary phone
    const eventIds = new Set(rows.map((r) => r.eventId));
    expect(eventIds.size).toBe(2); // distinct ids despite identical at/type/label
    const tsEventIds = new Set(rows.map((r) => r.tsEventId));
    expect(tsEventIds.size).toBe(2); // distinct PK+SK → both survive a Put
    for (const r of rows) {
      expect(r.type).toBe('number_added');
      expect(r.at).toBe(sameInstant);
    }
  });

  it('supersedes the 4 pre-seeded matrix activity rows (no duplicate eventId survives; covered contacts keep a timeline)', () => {
    const pre = matrixItems()['activity_events'] ?? [];
    expect(pre.length).toBe(4);
    for (const preRow of pre) {
      const cid = String(preRow['contactId']);
      // The hand-authored matrix eventId is gone (superseded by the generator).
      expect(result.activity_events.some((r) => r.eventId === preRow['eventId'])).toBe(false);
      // …but the contact still has a (regenerated) timeline.
      expect((byContact.get(cid) ?? []).length).toBeGreaterThan(0);
    }
  });

  it('preserves a pre-existing activity row for a contact the generator does NOT cover', () => {
    const tables: Record<string, Record<string, unknown>[]> = {
      contacts: [],
      placements: [],
      units: [],
      tours: [],
      listing_sends: [],
      audit_events: [],
      activity_events: [
        {
          contactId: 'contact-uncovered-01',
          tsEventId: '2026-03-01T00:00:00.000Z#evt-mx-listing-sent-xxxx',
          eventId: 'evt-mx-listing-sent-xxxx',
          at: '2026-03-01T00:00:00.000Z',
          type: 'listing_sent',
          label: 'Property sent',
          created_at: '2026-03-01T00:00:00.000Z',
        },
      ],
    };
    const out = historyItems(tables);
    expect(out.activity_events.some((r) => r.eventId === 'evt-mx-listing-sent-xxxx')).toBe(true);
  });

  it('is byte-stable: two runs produce identical activity_events', () => {
    const a = JSON.stringify(historyItems(buildFullTables()).activity_events);
    const b = JSON.stringify(historyItems(buildFullTables()).activity_events);
    expect(a).toBe(b);
  });
});

describe('seed history — lean profile is never touched (byte-stability contract)', () => {
  it('the lean SEED audit_events keep exactly their 2 hand-authored rows unchanged', () => {
    const rows = SEED['audit_events'] ?? [];
    expect(rows.length).toBe(2);
    // history.ts must NOT mutate the lean fixtures
    expect(rows.some((r) => r['event_type'] === 'contact.profile_edited')).toBe(true);
    expect(rows.some((r) => r['event_type'] === 'placement_stage_changed')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// DB-backed proof: a real seedAll(_, 'full') completes and the pinned placement
// reads back as a coherent trail via auditRepo.listByEntity (newest-first).
// ---------------------------------------------------------------------------
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
  console.warn(`[seedHistory.integration] SKIPPED — no DynamoDB Local at ${endpoint}.`);
}

describe.skipIf(!reachable)('seed history — full profile round-trip (DynamoDB Local)', () => {
  // HERMETIC: seed into a THROWAWAY table prefix (created in beforeAll, dropped in
  // afterAll) rather than the shared hc-local- tables. seedAll is upsert-only (Put,
  // never Delete), so reusing the shared tables lets a stale hand-authored lean row
  // (the bare-ISO placements#placement-0001 hop, SK with no `#suffix`) survive from a
  // PRIOR lean seed and inflate the read-back count — a false "dedupe regression". A
  // private prefix guarantees the round-trip observes ONLY what this seedAll wrote.
  const prefix = `hc-hist-${randomUUID().slice(0, 8)}-`;
  const testEnv: { TABLE_PREFIX?: string } = { TABLE_PREFIX: prefix };
  const origPrefix = process.env.TABLE_PREFIX;
  let adminClient: ReturnType<typeof createDynamoClient> | undefined;

  beforeAll(async () => {
    process.env.DYNAMODB_ENDPOINT = endpoint;
    process.env.TABLE_PREFIX = prefix;
    adminClient = createDynamoClient({ endpoint });
    for (const spec of TABLES) {
      await ensureTable(adminClient, spec, `${prefix}${spec.baseName}`);
    }
  }, 120_000);

  afterAll(async () => {
    if (origPrefix === undefined) delete process.env.TABLE_PREFIX;
    else process.env.TABLE_PREFIX = origPrefix;
    if (adminClient) {
      for (const spec of TABLES) {
        await deleteTableIfExists(adminClient, `${prefix}${spec.baseName}`);
      }
      adminClient.destroy();
    }
  }, 120_000);

  it('seedAll(_, "full") completes and placement-0001 reads back as a coherent stage trail', async () => {
    const { seedAll } = await import('../src/lib/seed/index.js');
    const { createDocumentClient } = await import('../src/lib/dynamo.js');
    const { createAuditRepo } = await import('../src/repos/auditRepo.js');

    await seedAll(endpoint, 'full');

    const doc = createDocumentClient({ endpoint });
    try {
      const audit = createAuditRepo({ doc, env: testEnv });
      const history = await audit.listByEntity('placements#placement-0001');
      const stageRows = history.filter((r) => r.event_type === 'placement_stage_changed');
      // newest-first (ScanIndexForward:false); the newest is the current stage
      expect(stageRows.length).toBe(stageIdx('awaiting_inspection')); // 10 hops
      expect(stageRows[0]!.payload!['to']).toBe('awaiting_inspection');
      expect(stageRows[stageRows.length - 1]!.payload!['from']).toBe('send_application');
      // unit activity card has a publish + derived rows
      const unitActivity = await audit.listByEntity('units#unit-0001');
      expect(unitActivity.some((r) => r.event_type === 'listing_status_changed')).toBe(true);

      // Contact Timeline milestones (Task 3a persistence gap): seedAll('full') must
      // persist activity_events too — NOT just audit_events. We read the pinned
      // placement's tenant timeline back through the REAL activityEventsRepo (a
      // newest-first round-trip) WITHOUT any manual Put loop here, so a green
      // assertion proves index.ts routed history.activity_events through the real
      // Put path. (A regression that drops the wiring makes this timeline empty.)
      const { createActivityEventsRepo } = await import('../src/repos/activityEventsRepo.js');
      const activityRepo = createActivityEventsRepo({ doc, env: testEnv });
      const leanTenantId = String(
        (PLACEMENTS.find((p) => p['placementId'] === 'placement-0001') ?? {})['tenantId'],
      );
      const { items: timeline } = await activityRepo.listByContact(leanTenantId);
      expect(timeline.length).toBeGreaterThan(0);
      expect(
        timeline.some(
          (i) => i.type === 'placement_opened' || i.type === 'stage_changed' || i.type === 'placement_closed',
        ),
      ).toBe(true);
    } finally {
      doc.destroy();
    }
  }, 60_000);

  it('a seeded TOURED tour reads back as a newest-first tours# trail projecting to known labels', async () => {
    // Task 2: the tour detail page's Activity read is auditRepo.listByEntity
    // (`tours#<id>`, newest-first) -> the GET /:id/activity projection. Prove a
    // real seedAll('full') persists the tours# trail and it reads back coherent.
    const { seedAll } = await import('../src/lib/seed/index.js');
    const { createDocumentClient } = await import('../src/lib/dynamo.js');
    const { createAuditRepo } = await import('../src/repos/auditRepo.js');

    await seedAll(endpoint, 'full'); // idempotent upsert (round-trip prefix)

    const doc = createDocumentClient({ endpoint });
    try {
      const audit = createAuditRepo({ doc, env: testEnv });
      // The cast toured tour (cast.ts): status 'toured' + groupThreadId + outcome
      // 'move_forward' -> trail { tour_scheduled, tour_group_opened,
      // tour_took_place, tour_outcome }. Read NEWEST-FIRST (ScanIndexForward:false).
      const TOURED_ID = 'tour-cast-toured-yes-tenant';
      const rows = await audit.listByEntity(`tours#${TOURED_ID}`);
      expect(new Set(rows.map((r) => r.event_type))).toEqual(
        new Set(['tour_scheduled', 'tour_group_opened', 'tour_took_place', 'tour_outcome']),
      );
      expect(rows.length).toBe(4); // hermetic prefix: only this seedAll wrote them

      // Newest-first: instants monotonically NON-INCREASING. outcome is the newest
      // instant, then took_place; the two booking-instant rows (tour_scheduled +
      // tour_group_opened share createdAt) trail last, their relative order set by
      // the SK suffix (task section 2: outcome?, took_place, [group_opened?], scheduled).
      const isoAt = (r: { ts: string }) => r.ts.slice(0, r.ts.indexOf('#'));
      for (let i = 1; i < rows.length; i++) {
        expect(isoAt(rows[i - 1]!) >= isoAt(rows[i]!), `row ${i} newest-first`).toBe(true);
      }
      expect(rows[0]!.event_type).toBe('tour_outcome'); // strictly-newest instant
      expect(rows[1]!.event_type).toBe('tour_took_place');
      expect(new Set([rows[2]!.event_type, rows[3]!.event_type])).toEqual(
        new Set(['tour_scheduled', 'tour_group_opened']),
      );

      // Every row type is one of the 8 dashboard TOUR_EVENT_LABELS keys, so the
      // dashboard's describeTourActivity resolves a REAL label (never the
      // humanize() fallback). Pinned literal mirror (the dashboard module is not
      // importable from app tests) - a drift alarm.
      const TOUR_LABEL_KEYS = new Set<string>([
        'tour_scheduled',
        'tour_rescheduled',
        'tour_took_place',
        'tour_no_show',
        'tour_canceled',
        'tour_outcome',
        'tour_group_opened',
        'tour_converted',
      ]);
      for (const r of rows) {
        expect(TOUR_LABEL_KEYS.has(r.event_type), `${r.event_type} is a known label key`).toBe(true);
      }

      // Repo-layer projection shape (mirrors the GET /:id/activity fixed-key
      // whitelist in routes/tours.ts: id/at/type + tourId/placementId/conversationId;
      // NO raw payload leak, NO actor on archive writes). Label resolution itself is
      // dashboard-side (verified via the pinned key set above); this pins the wire shape.
      const projected = rows.map((r) => {
        const at = isoAt(r);
        const p = (r.payload ?? {}) as Record<string, unknown>;
        const pick = (k: string): string | undefined =>
          typeof p[k] === 'string' ? (p[k] as string) : undefined;
        return {
          id: r.ts,
          at,
          type: r.event_type,
          ...(pick('tourId') !== undefined && { tourId: pick('tourId') }),
          ...(pick('conversationId') !== undefined && { conversationId: pick('conversationId') }),
          ...(pick('placementId') !== undefined && { placementId: pick('placementId') }),
        } as Record<string, unknown>;
      });
      for (const e of projected) {
        expect((e['id'] as string).startsWith(e['at'] as string)).toBe(true);
        expect(e['tourId']).toBe(TOURED_ID); // whitelisted payload.tourId rides through
        expect(e['payload']).toBeUndefined(); // raw payload never leaks
      }
      for (const r of rows) expect(r.actorId, 'archive tour write carries no actor').toBeUndefined();
      // group_opened carries its conversationId deep-link target through the whitelist.
      const grp = projected.find((e) => e['type'] === 'tour_group_opened')!;
      expect(typeof grp['conversationId']).toBe('string');
    } finally {
      doc.destroy();
    }
  }, 60_000);
});

// ---------------------------------------------------------------------------
// FIDELITY PIN (Task 3c): the generator's placement audit row must match what the
// REAL statusTransition service writes for the same hop. We drive one genuine
// transitionPlacement() hop against DynamoDB Local, read the persisted audit row
// back via auditRepo.listByEntity, and assert the generator's row for that same
// (from,to,source) hop agrees on event_type + payload key-set + source. If the
// service's audit shape ever drifts (new/renamed payload key, different
// event_type), this test fails — pointing straight at history.ts as needing a
// matching update. Hermetic: its own throwaway prefix (upsert-only seed can't
// pollute it).
// ---------------------------------------------------------------------------
describe.skipIf(!reachable)('seed history — generator ↔ real statusTransition audit fidelity', () => {
  const prefix = `hc-fid-${randomUUID().slice(0, 8)}-`;
  const testEnv: { TABLE_PREFIX?: string } = { TABLE_PREFIX: prefix };
  const origPrefix = process.env.TABLE_PREFIX;
  let adminClient: ReturnType<typeof createDynamoClient> | undefined;

  beforeAll(async () => {
    process.env.DYNAMODB_ENDPOINT = endpoint;
    process.env.TABLE_PREFIX = prefix;
    adminClient = createDynamoClient({ endpoint });
    for (const spec of TABLES) {
      await ensureTable(adminClient, spec, `${prefix}${spec.baseName}`);
    }
  }, 120_000);

  afterAll(async () => {
    if (origPrefix === undefined) delete process.env.TABLE_PREFIX;
    else process.env.TABLE_PREFIX = origPrefix;
    if (adminClient) {
      for (const spec of TABLES) {
        await deleteTableIfExists(adminClient, `${prefix}${spec.baseName}`);
      }
      adminClient.destroy();
    }
  }, 120_000);

  it('generator placement_stage_changed row matches the real service audit for the same hop', async () => {
    const { PutCommand } = await import('@aws-sdk/lib-dynamodb');
    const { createDocumentClient } = await import('../src/lib/dynamo.js');
    const { createStatusTransitionService } = await import('../src/services/statusTransition.js');
    const { createPlacementsRepo } = await import('../src/repos/placementsRepo.js');
    const { createPlacementDeadlinesRepo } = await import('../src/repos/placementDeadlinesRepo.js');
    const { createUnitsRepo } = await import('../src/repos/unitsRepo.js');
    const { createContactsRepo } = await import('../src/repos/contactsRepo.js');
    const { createAuditRepo } = await import('../src/repos/auditRepo.js');
    const { createEventBus } = await import('../src/lib/events.js');

    const doc = createDocumentClient({ endpoint });
    try {
      // Minimal cast for ONE real hop: send_application → awaiting_receipt (manual).
      const FROM: PlacementStage = 'send_application';
      const TO: PlacementStage = 'awaiting_receipt';
      const SOURCE = 'manual' as const;
      const ACTOR = 'user-fidelity';
      const placementId = 'placement-fid-01';
      const tenantId = 'contact-fid-tenant-01';
      const unitId = 'unit-fid-01';
      const anchor = '2026-05-01T00:00:00.000Z';

      // Seed the driving entities directly (Put) so the service can load them.
      await doc.send(new PutCommand({
        TableName: `${prefix}placements`,
        Item: { placementId, tenantId, unitId, stage: FROM, stage_source: 'manual', stage_entered_at: anchor, created_at: anchor },
      }));
      await doc.send(new PutCommand({
        TableName: `${prefix}contacts`,
        Item: { contactId: tenantId, type: 'tenant', status: 'needs_review', created_at: anchor },
      }));
      await doc.send(new PutCommand({
        TableName: `${prefix}units`,
        Item: { unitId, status: 'available', status_source: 'manual', created_at: anchor },
      }));

      // Construct the REAL service from doc-backed repos + a throwaway event bus.
      const svc = createStatusTransitionService({
        placementsRepo: createPlacementsRepo({ doc, env: testEnv }),
        placementDeadlinesRepo: createPlacementDeadlinesRepo({ doc, env: testEnv }),
        unitsRepo: createUnitsRepo({ doc, env: testEnv }),
        contactsRepo: createContactsRepo({ doc, env: testEnv }),
        auditRepo: createAuditRepo({ doc, env: testEnv }),
        events: createEventBus(),
      });

      // Drive ONE genuine hop through the real write path.
      await svc.transitionPlacement(placementId, { toStage: TO, source: SOURCE, actor: ACTOR });

      // Read the persisted audit row back for this hop.
      const audit = createAuditRepo({ doc, env: testEnv });
      const rows = await audit.listByEntity(`placements#${placementId}`);
      const realRow = rows.find(
        (r) => r.event_type === 'placement_stage_changed' && r.payload?.['from'] === FROM && r.payload?.['to'] === TO,
      );
      expect(realRow, 'real service must have written the stage-change audit row').toBeDefined();

      // The GENERATOR's row for the SAME hop: build a placement that ends at TO and
      // pick the from→to row out of its walk.
      const generated = placementHistory({
        placementId,
        tenantId,
        unitId,
        stage: TO,
        stage_entered_at: anchor,
      }).find(
        (r) => r.event_type === 'placement_stage_changed' && r.payload['from'] === FROM && r.payload['to'] === TO,
      );
      expect(generated, 'generator must produce the same from→to row').toBeDefined();

      // FIDELITY: same event_type, same payload KEY-SET, same source value. (Actor
      // VALUE legitimately differs — the seed pins user-0001, the test drove user-
      // fidelity — but both carry the `actor` key, so the key-set matches.)
      expect(generated!.event_type).toBe(realRow!.event_type);
      expect(generated!.payload['source']).toBe(realRow!.payload!['source']);
      const realKeys = Object.keys(realRow!.payload ?? {}).sort();
      const genKeys = Object.keys(generated!.payload).sort();
      expect(genKeys).toEqual(realKeys); // [actor, from, to, source]
      // And the top-level actorId hoist mirrors payload.actor on both sides.
      expect(typeof realRow!.actorId).toBe('string');
      expect(typeof generated!.actorId).toBe('string');
    } finally {
      doc.destroy();
    }
  }, 60_000);

  // LOST hop: the payload gains `lost_reason_category` (statusTransition.ts:306-308).
  // Drive a real → lost transition, read back the placement_stage_changed row, and
  // assert the generator's `→ lost` row agrees on event_type + payload KEY-SET
  // (including lost_reason_category) + source. A drift in the service's lost audit
  // shape (a renamed/dropped category key) fails here.
  it('generator → lost row matches the real service lost audit (payload gains lost_reason_category)', async () => {
    const { PutCommand } = await import('@aws-sdk/lib-dynamodb');
    const { createDocumentClient } = await import('../src/lib/dynamo.js');
    const { createStatusTransitionService } = await import('../src/services/statusTransition.js');
    const { createPlacementsRepo } = await import('../src/repos/placementsRepo.js');
    const { createPlacementDeadlinesRepo } = await import('../src/repos/placementDeadlinesRepo.js');
    const { createUnitsRepo } = await import('../src/repos/unitsRepo.js');
    const { createContactsRepo } = await import('../src/repos/contactsRepo.js');
    const { createAuditRepo } = await import('../src/repos/auditRepo.js');
    const { createEventBus } = await import('../src/lib/events.js');

    const doc = createDocumentClient({ endpoint });
    try {
      // A real hop from an active stage → the TERMINAL `lost`, carrying a structured
      // lost reason (category). The service records `lost_reason_category` from the
      // stored lost_reason (ReturnValues:ALL_NEW), never the free text (§9 PII).
      const FROM: PlacementStage = 'send_application';
      const SOURCE = 'manual' as const;
      const ACTOR = 'user-fidelity';
      const CATEGORY = 'no_contact';
      const placementId = 'placement-fid-lost';
      const tenantId = 'contact-fid-lost-tenant';
      const unitId = 'unit-fid-lost';
      const anchor = '2026-05-01T00:00:00.000Z';

      await doc.send(new PutCommand({
        TableName: `${prefix}placements`,
        Item: { placementId, tenantId, unitId, stage: FROM, stage_source: 'manual', stage_entered_at: anchor, created_at: anchor },
      }));
      await doc.send(new PutCommand({
        TableName: `${prefix}contacts`,
        Item: { contactId: tenantId, type: 'tenant', status: 'needs_review', created_at: anchor },
      }));
      await doc.send(new PutCommand({
        TableName: `${prefix}units`,
        Item: { unitId, status: 'available', status_source: 'manual', created_at: anchor },
      }));

      const svc = createStatusTransitionService({
        placementsRepo: createPlacementsRepo({ doc, env: testEnv }),
        placementDeadlinesRepo: createPlacementDeadlinesRepo({ doc, env: testEnv }),
        unitsRepo: createUnitsRepo({ doc, env: testEnv }),
        contactsRepo: createContactsRepo({ doc, env: testEnv }),
        auditRepo: createAuditRepo({ doc, env: testEnv }),
        events: createEventBus(),
      });

      // Drive the genuine → lost hop with a structured category.
      await svc.transitionPlacement(placementId, {
        toStage: 'lost',
        source: SOURCE,
        lostReason: { category: CATEGORY },
        actor: ACTOR,
      });

      const audit = createAuditRepo({ doc, env: testEnv });
      const rows = await audit.listByEntity(`placements#${placementId}`);
      const realRow = rows.find(
        (r) => r.event_type === 'placement_stage_changed' && r.payload?.['to'] === 'lost',
      );
      expect(realRow, 'real service must have written the → lost stage-change audit row').toBeDefined();
      // The service stamped the category (NOT the free text) onto the audit payload.
      expect(realRow!.payload!['lost_reason_category']).toBe(CATEGORY);

      // The GENERATOR's `→ lost` row for a placement ending at `lost` with the same
      // category. (The `from` VALUE legitimately differs — the generator picks a
      // plausible lost-from stage by category — but the SHAPE must match.)
      const generated = placementHistory({
        placementId,
        tenantId,
        unitId,
        stage: 'lost',
        stage_entered_at: anchor,
        lost_reason: { category: CATEGORY },
      }).find((r) => r.event_type === 'placement_stage_changed' && r.payload['to'] === 'lost');
      expect(generated, 'generator must produce a → lost row').toBeDefined();
      expect(generated!.payload['lost_reason_category']).toBe(CATEGORY);

      // FIDELITY: same event_type, same source value, same payload KEY-SET — and the
      // key-set MUST include lost_reason_category on both sides.
      expect(generated!.event_type).toBe(realRow!.event_type);
      expect(generated!.payload['source']).toBe(realRow!.payload!['source']);
      const realKeys = Object.keys(realRow!.payload ?? {}).sort();
      const genKeys = Object.keys(generated!.payload).sort();
      expect(genKeys).toEqual(realKeys); // [actor, from, lost_reason_category, source, to]
      expect(realKeys).toContain('lost_reason_category');
      // Manual hop → both carry an actor (hoisted to actorId).
      expect(typeof realRow!.actorId).toBe('string');
      expect(typeof generated!.actorId).toBe('string');
    } finally {
      doc.destroy();
    }
  }, 60_000);

  // DERIVED side-effects: a status-flipping transition fires `tenant_status_changed`
  // / `listing_status_changed` rows with `source:'derived'` and NO actor (so
  // auditRepo hoists NO actorId). Drive a fresh placement forward one hop
  // (needs_review→placing tenant, available→under_application unit), read both
  // derived rows back, and assert the generator's derived rows agree on event_type +
  // payload KEY-SET + source:'derived' + the ABSENT actorId.
  it('generator derived rows match the real service derived audit (source:derived, NO actorId)', async () => {
    const { PutCommand } = await import('@aws-sdk/lib-dynamodb');
    const { createDocumentClient } = await import('../src/lib/dynamo.js');
    const { createStatusTransitionService } = await import('../src/services/statusTransition.js');
    const { createPlacementsRepo } = await import('../src/repos/placementsRepo.js');
    const { createPlacementDeadlinesRepo } = await import('../src/repos/placementDeadlinesRepo.js');
    const { createUnitsRepo } = await import('../src/repos/unitsRepo.js');
    const { createContactsRepo } = await import('../src/repos/contactsRepo.js');
    const { createAuditRepo } = await import('../src/repos/auditRepo.js');
    const { createEventBus } = await import('../src/lib/events.js');

    const doc = createDocumentClient({ endpoint });
    try {
      // Fresh baselines (tenant needs_review, unit available) so ONE manual advance
      // flips both coarse statuses via deriveStatuses (§7): tenant → placing, unit →
      // under_application — each a `source:'derived'` side-effect audit row.
      const TO: PlacementStage = 'awaiting_receipt';
      const SOURCE = 'manual' as const;
      const ACTOR = 'user-fidelity';
      const placementId = 'placement-fid-derived';
      const tenantId = 'contact-fid-derived-tenant';
      const unitId = 'unit-fid-derived';
      const anchor = '2026-05-01T00:00:00.000Z';

      await doc.send(new PutCommand({
        TableName: `${prefix}placements`,
        Item: { placementId, tenantId, unitId, stage: 'send_application', stage_source: 'manual', stage_entered_at: anchor, created_at: anchor },
      }));
      await doc.send(new PutCommand({
        TableName: `${prefix}contacts`,
        Item: { contactId: tenantId, type: 'tenant', status: 'needs_review', created_at: anchor },
      }));
      await doc.send(new PutCommand({
        TableName: `${prefix}units`,
        Item: { unitId, status: 'available', status_source: 'manual', created_at: anchor },
      }));

      const svc = createStatusTransitionService({
        placementsRepo: createPlacementsRepo({ doc, env: testEnv }),
        placementDeadlinesRepo: createPlacementDeadlinesRepo({ doc, env: testEnv }),
        unitsRepo: createUnitsRepo({ doc, env: testEnv }),
        contactsRepo: createContactsRepo({ doc, env: testEnv }),
        auditRepo: createAuditRepo({ doc, env: testEnv }),
        events: createEventBus(),
      });

      // ACTOR is supplied on the transition — but the DERIVED side-effect rows are
      // system writes and must NOT inherit it (the service passes no actor to the
      // derive helpers). This asserts that separation holds end-to-end.
      await svc.transitionPlacement(placementId, { toStage: TO, source: SOURCE, actor: ACTOR });

      const audit = createAuditRepo({ doc, env: testEnv });
      const realTenant = (await audit.listByEntity(`contacts#${tenantId}`)).find(
        (r) => r.event_type === 'tenant_status_changed' && r.payload?.['source'] === 'derived',
      );
      const realUnit = (await audit.listByEntity(`units#${unitId}`)).find(
        (r) => r.event_type === 'listing_status_changed' && r.payload?.['source'] === 'derived',
      );
      expect(realTenant, 'service must write a derived tenant_status_changed row').toBeDefined();
      expect(realUnit, 'service must write a derived listing_status_changed row').toBeDefined();
      // Derived = system → auditRepo hoists NO actorId (payload carries no `actor`).
      expect(realTenant!.actorId).toBeUndefined();
      expect(realUnit!.actorId).toBeUndefined();
      expect(realTenant!.payload!['to']).toBe('placing');
      expect(realUnit!.payload!['to']).toBe('under_application');

      // The GENERATOR's derived rows for the same one-hop walk.
      const gen = placementHistory({ placementId, tenantId, unitId, stage: TO, stage_entered_at: anchor });
      const genTenant = gen.find(
        (r) => r.event_type === 'tenant_status_changed' && r.payload['source'] === 'derived',
      );
      const genUnit = gen.find(
        (r) => r.event_type === 'listing_status_changed' && r.payload['source'] === 'derived',
      );
      expect(genTenant, 'generator must emit a derived tenant row').toBeDefined();
      expect(genUnit, 'generator must emit a derived unit row').toBeDefined();
      // The generator likewise emits NO actor on derived rows → no actorId hoisted.
      expect(genTenant!.actorId).toBeUndefined();
      expect(genUnit!.actorId).toBeUndefined();

      // FIDELITY: same event_type + source:'derived' + payload KEY-SET on both rows.
      expect(genTenant!.event_type).toBe(realTenant!.event_type);
      expect(genUnit!.event_type).toBe(realUnit!.event_type);
      expect(genTenant!.payload['source']).toBe('derived');
      expect(genUnit!.payload['source']).toBe('derived');
      expect(Object.keys(genTenant!.payload).sort()).toEqual(
        Object.keys(realTenant!.payload ?? {}).sort(),
      ); // [from, source, to]
      expect(Object.keys(genUnit!.payload).sort()).toEqual(
        Object.keys(realUnit!.payload ?? {}).sort(),
      ); // [from, source, to]
    } finally {
      doc.destroy();
    }
  }, 60_000);
});
