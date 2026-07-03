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
  type PlacementStage,
} from '../src/lib/statusModel.js';
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
  LIFECYCLE_EVENT_TYPES,
  type AuditRow,
} from '../src/lib/seed/history.js';

// --- helpers ----------------------------------------------------------------
const iso = (ts: string) => ts.split('#')[0]!;
const isoList = (rows: AuditRow[]) => rows.map((r) => iso(r.ts));
const strictlyIncreasing = (xs: string[]) => xs.every((x, i) => i === 0 || xs[i - 1]! < x);

/** Build the FULL item map the way seedAll('full') does (lean + cast + matrix). */
function buildFullTables(): Record<string, Record<string, unknown>[]> {
  const tables: Record<string, Record<string, unknown>[]> = {};
  for (const [base, items] of Object.entries(SEED)) tables[base] = [...items];
  for (const [base, items] of Object.entries(castItems())) tables[base] = [...(tables[base] ?? []), ...items];
  for (const [base, items] of Object.entries(matrixItems())) tables[base] = [...(tables[base] ?? []), ...items];
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

  it('activity_events is left to Task 2 (returns [])', () => {
    expect(result.activity_events).toEqual([]);
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
    } finally {
      doc.destroy();
    }
  }, 60_000);
});
