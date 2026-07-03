// Coherence assertions for the now-relative matrix placements (Task 1).
//
// Unlike seedMatrix.test.ts (coverage counts), this file asserts the
// CROSS-FIELD PLAUSIBILITY the audit demanded: deadlines whose type matches
// the placement's phase and whose date is on/after stage entry, backdated
// journeys (created_at ≤ stage_entered_at), phase-scoped attention reasons,
// coherent moved_in ordering, and — the headline regression — NO placement
// anywhere carrying a `tour_reminder` deadline.
//
// All assertions run against the in-memory output of matrixItems(now) with a
// FIXED now, so they are deterministic and DB-free.
import { describe, expect, it } from 'vitest';
import {
  matrixItems,
  PHASE_DEADLINE_TYPES,
  attentionReasonPool,
} from '../src/lib/seed/matrix.js';
import {
  PLACEMENT_STAGES,
  STAGE_PHASE,
  deriveStatuses,
  type PlacementStage,
} from '../src/lib/statusModel.js';

// A fixed clock — every date in the matrix derives from this instant.
const NOW = new Date('2026-07-03T12:00:00.000Z');
const NOW_MS = NOW.getTime();

const ITEMS = matrixItems(NOW);
const PLACEMENTS = ITEMS['placements'] ?? [];

const ms = (v: unknown): number => Date.parse(String(v));
const stageOf = (p: Record<string, unknown>) => p['stage'] as PlacementStage;
const isActive = (p: Record<string, unknown>) =>
  stageOf(p) !== 'moved_in' && stageOf(p) !== 'lost';

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------
describe('matrix coherence: determinism', () => {
  it('matrixItems(fixedNow) is byte-identical across two calls', () => {
    const a = matrixItems(NOW);
    const b = matrixItems(NOW);
    expect(a).toEqual(b);
  });
});

// ---------------------------------------------------------------------------
// Deadline TYPE ∈ phase set, and NEVER tour_reminder — anywhere
// ---------------------------------------------------------------------------
describe('matrix coherence: deadline type ↔ phase', () => {
  it('NO placement (any stage) carries a tour_reminder deadline', () => {
    for (const p of PLACEMENTS) {
      expect(
        p['next_deadline_type'],
        `placement ${p['placementId']} must not be tour_reminder`,
      ).not.toBe('tour_reminder');
    }
  });

  it('every deadline-bearing placement has a type valid for its phase', () => {
    for (const p of PLACEMENTS) {
      const dt = p['next_deadline_type'] as string | undefined;
      if (dt === undefined) continue;
      const phase = STAGE_PHASE[stageOf(p)];
      const valid = PHASE_DEADLINE_TYPES[phase] as readonly string[];
      expect(
        valid.includes(dt),
        `placement ${p['placementId']} (${stageOf(p)}/${phase}): '${dt}' ∉ [${valid.join(', ')}]`,
      ).toBe(true);
    }
  });

  it('rta_window appears ONLY on RTA-phase placements', () => {
    for (const p of PLACEMENTS) {
      if (p['next_deadline_type'] !== 'rta_window') continue;
      expect(STAGE_PHASE[stageOf(p)], `rta_window on ${p['placementId']}`).toBe('RTA');
    }
  });
});

// ---------------------------------------------------------------------------
// Deadline DATE ≥ stage entry (the −130-day impossibility must be gone)
// ---------------------------------------------------------------------------
describe('matrix coherence: deadline date ≥ stage_entered_at', () => {
  it('every deadline is on/after the placement entered its stage', () => {
    for (const p of PLACEMENTS) {
      if (p['next_deadline_at'] === undefined) continue;
      expect(
        ms(p['next_deadline_at']),
        `placement ${p['placementId']}: next_deadline_at < stage_entered_at`,
      ).toBeGreaterThanOrEqual(ms(p['stage_entered_at']));
    }
  });

  it('attention-flagged active placements are genuinely overdue (deadline in the recent past)', () => {
    const flagged = PLACEMENTS.filter((p) => isActive(p) && p['attention'] !== undefined);
    expect(flagged.length, 'matrix must include ≥1 attention-flagged placement').toBeGreaterThanOrEqual(1);
    for (const p of flagged) {
      const dueMs = ms(p['next_deadline_at']);
      expect(dueMs, `attention placement ${p['placementId']} must be past-due`).toBeLessThan(NOW_MS);
      // …but only by DAYS, not months (no more Jan-dated deadlines in July).
      const daysPast = (NOW_MS - dueMs) / (24 * 60 * 60 * 1000);
      expect(daysPast, `attention placement ${p['placementId']} overdue by ${daysPast}d`).toBeLessThan(30);
    }
  });
});

// ---------------------------------------------------------------------------
// created_at ≤ stage_entered_at (strict for non-first stages)
// ---------------------------------------------------------------------------
describe('matrix coherence: backdated journey (created_at ≤ stage_entered_at)', () => {
  it('created_at ≤ stage_entered_at for every placement; strict for non-send_application stages', () => {
    for (const p of PLACEMENTS) {
      const created = ms(p['created_at']);
      const entered = ms(p['stage_entered_at']);
      expect(created, `placement ${p['placementId']}: created_at > stage_entered_at`).toBeLessThanOrEqual(entered);
      if (stageOf(p) !== 'send_application') {
        expect(
          created,
          `placement ${p['placementId']} (${stageOf(p)}): non-first stage must have created_at STRICTLY before stage_entered_at`,
        ).toBeLessThan(entered);
      }
    }
  });

  it('send_application placements keep created_at == stage_entered_at', () => {
    const firsts = PLACEMENTS.filter((p) => stageOf(p) === 'send_application');
    expect(firsts.length).toBeGreaterThanOrEqual(2);
    for (const p of firsts) {
      expect(ms(p['created_at'])).toBe(ms(p['stage_entered_at']));
    }
  });
});

// ---------------------------------------------------------------------------
// Attention reason ∈ phase-scoped set
// ---------------------------------------------------------------------------
describe('matrix coherence: attention reason ↔ phase', () => {
  it('every attention reason is in its stage/phase-scoped pool', () => {
    const flagged = PLACEMENTS.filter((p) => p['attention'] !== undefined);
    for (const p of flagged) {
      const reason = (p['attention'] as { reason: string }).reason;
      const pool = attentionReasonPool(stageOf(p));
      expect(
        pool.includes(reason),
        `placement ${p['placementId']} (${stageOf(p)}): reason '${reason}' ∉ [${pool.join(', ')}]`,
      ).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// moved_in ordering
// ---------------------------------------------------------------------------
describe('matrix coherence: moved_in date ordering', () => {
  const movedIn = PLACEMENTS.filter((p) => stageOf(p) === 'moved_in');

  it('has ≥2 moved_in placements', () => {
    expect(movedIn.length).toBeGreaterThanOrEqual(2);
  });

  it('created_at ≤ lease_date ≤ move_in_date ≤ now for every moved_in placement', () => {
    for (const p of movedIn) {
      const created = ms(p['created_at']);
      const lease = ms(p['lease_date']);
      const moveIn = ms(p['move_in_date']);
      expect(created, `${p['placementId']}: created_at ≤ lease_date`).toBeLessThanOrEqual(lease);
      expect(lease, `${p['placementId']}: lease_date ≤ move_in_date`).toBeLessThanOrEqual(moveIn);
      expect(moveIn, `${p['placementId']}: move_in_date ≤ now`).toBeLessThanOrEqual(NOW_MS);
    }
  });

  it("the linked tenant's move_in_date/consent_at cohere with the placement", () => {
    const tenants = new Map(
      (ITEMS['contacts'] ?? [])
        .filter((c) => c['type'] === 'tenant')
        .map((c) => [c['contactId'] as string, c]),
    );
    for (const p of movedIn) {
      const t = tenants.get(p['tenantId'] as string);
      expect(t, `tenant for ${p['placementId']} must exist`).toBeDefined();
      // Tenant move_in matches the placement move_in.
      expect(ms(t!['move_in_date']), `${p['placementId']}: tenant move_in_date`).toBe(ms(p['move_in_date']));
      // Consent predates (or equals) move-in.
      expect(ms(t!['consent_at']), `${p['placementId']}: consent_at ≤ move_in_date`).toBeLessThanOrEqual(ms(p['move_in_date']));
    }
  });
});

// ---------------------------------------------------------------------------
// Coverage retained: every active stage ×2; every phase-valid type present
// ---------------------------------------------------------------------------
describe('matrix coherence: coverage retained', () => {
  it('every active PLACEMENT_STAGE appears exactly ≥2 times in the matrix', () => {
    const counts: Record<string, number> = {};
    for (const p of PLACEMENTS) counts[stageOf(p)] = (counts[stageOf(p)] ?? 0) + 1;
    for (const stage of PLACEMENT_STAGES) {
      expect(counts[stage] ?? 0, `stage '${stage}'`).toBeGreaterThanOrEqual(2);
    }
  });

  it('every phase-valid deadline type (excluding tour_reminder) appears ≥1 in the matrix', () => {
    const present = new Set(
      PLACEMENTS.map((p) => p['next_deadline_type'] as string | undefined).filter(Boolean),
    );
    // Union of all phase sets = the placement-valid deadline types.
    const expected = new Set<string>();
    for (const types of Object.values(PHASE_DEADLINE_TYPES)) for (const t of types) expected.add(t);
    for (const t of expected) {
      expect(present.has(t), `deadline type '${t}' must appear ≥1 in the matrix`).toBe(true);
    }
    expect(expected.has('tour_reminder'), 'tour_reminder must not be a placement-valid type').toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Previously-broken cases (regression anchors from the audit)
// ---------------------------------------------------------------------------
describe('matrix coherence: previously-broken cases now pass', () => {
  it('a collect_rta placement carries an RTA-valid, correctly-dated deadline', () => {
    const collectRta = PLACEMENTS.filter((p) => stageOf(p) === 'collect_rta' && p['next_deadline_type'] !== undefined);
    expect(collectRta.length, 'expected ≥1 deadline-bearing collect_rta placement').toBeGreaterThanOrEqual(1);
    for (const p of collectRta) {
      const dt = p['next_deadline_type'] as string;
      expect(dt).not.toBe('tour_reminder');
      expect((PHASE_DEADLINE_TYPES['RTA'] as readonly string[]).includes(dt), `collect_rta deadline '${dt}' must be RTA-valid`).toBe(true);
      expect(ms(p['next_deadline_at'])).toBeGreaterThanOrEqual(ms(p['stage_entered_at']));
    }
  });

  it('linked tenant/unit statuses still match deriveStatuses(stage)', () => {
    const tenants = new Map((ITEMS['contacts'] ?? []).filter((c) => c['type'] === 'tenant').map((c) => [c['contactId'] as string, c]));
    const units = new Map((ITEMS['units'] ?? []).map((u) => [u['unitId'] as string, u]));
    for (const p of PLACEMENTS) {
      const derived = deriveStatuses(stageOf(p));
      const t = tenants.get(p['tenantId'] as string);
      const u = units.get(p['unitId'] as string);
      expect(t?.['status'], `tenant status for ${p['placementId']}`).toBe(derived.tenantStatus);
      expect(u?.['status'], `unit status for ${p['placementId']}`).toBe(derived.listingStatus);
    }
  });
});
