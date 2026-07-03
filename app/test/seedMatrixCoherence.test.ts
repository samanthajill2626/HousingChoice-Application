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
import { TOUR_STATUSES, type TourStatus } from '../src/lib/toursModel.js';
import { historyItems } from '../src/lib/seed/history.js';

// A fixed clock — every date in the matrix derives from this instant.
const NOW = new Date('2026-07-03T12:00:00.000Z');
const NOW_MS = NOW.getTime();

const ITEMS = matrixItems(NOW);
const PLACEMENTS = ITEMS['placements'] ?? [];
const TOURS = ITEMS['tours'] ?? [];
const TOUR_REMINDERS = ITEMS['tourReminders'] ?? [];

const ms = (v: unknown): number => Date.parse(String(v));
const stageOf = (p: Record<string, unknown>) => p['stage'] as PlacementStage;
const isActive = (p: Record<string, unknown>) =>
  stageOf(p) !== 'moved_in' && stageOf(p) !== 'lost';

// Tour helpers.
const tourStatusOf = (t: Record<string, unknown>) => t['status'] as TourStatus;
const remindersOf = (tourId: string) => TOUR_REMINDERS.filter((r) => r['tourId'] === tourId);
const isPending = (r: Record<string, unknown>) => r['sentAt'] === undefined && r['canceledAt'] === undefined;
/** The terminal instant of a reminder (sentAt ?? canceledAt), or +∞ when pending. */
const terminalMs = (r: Record<string, unknown>): number =>
  r['sentAt'] !== undefined ? ms(r['sentAt']) : r['canceledAt'] !== undefined ? ms(r['canceledAt']) : Infinity;
const UPCOMING_TOUR = new Set<TourStatus>(['scheduled', 'confirmed']);
const PAST_TOUR = new Set<TourStatus>(['toured', 'no_show', 'canceled', 'closed']);

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

// ---------------------------------------------------------------------------
// Minor (Task 1 review, folded here): active placements entered their stage in
// the past — no now-relative placement is dated in the future.
// ---------------------------------------------------------------------------
describe('matrix coherence: active placement stage_entered_at ≤ now', () => {
  it('every ACTIVE placement entered its stage on/before now', () => {
    const actives = PLACEMENTS.filter(isActive);
    expect(actives.length, 'matrix must include active placements').toBeGreaterThanOrEqual(2);
    for (const p of actives) {
      expect(
        ms(p['stage_entered_at']),
        `active placement ${p['placementId']}: stage_entered_at > now`,
      ).toBeLessThanOrEqual(NOW_MS);
    }
  });
});

// ---------------------------------------------------------------------------
// TOURS + reminders — now-relative and coherent (findings §B)
// ---------------------------------------------------------------------------
describe('matrix coherence: tour coverage + requested invariant', () => {
  it('every TOUR_STATUS appears ≥2 times', () => {
    const counts: Record<string, number> = {};
    for (const t of TOURS) counts[tourStatusOf(t)] = (counts[tourStatusOf(t)] ?? 0) + 1;
    for (const status of TOUR_STATUSES) {
      expect(counts[status] ?? 0, `tour status '${status}'`).toBeGreaterThanOrEqual(2);
    }
  });

  it("'requested' tours are timeless (no scheduledAt) and carry ZERO reminders", () => {
    const requested = TOURS.filter((t) => tourStatusOf(t) === 'requested');
    expect(requested.length).toBeGreaterThanOrEqual(2);
    for (const t of requested) {
      expect(t['scheduledAt'], `requested ${t['tourId']} must have no scheduledAt`).toBeUndefined();
      expect(t['_schedPartition'], `requested ${t['tourId']} must not be on the scheduled GSI`).toBeUndefined();
      expect(remindersOf(t['tourId'] as string).length, `requested ${t['tourId']} reminder count`).toBe(0);
    }
  });
});

describe('matrix coherence: tour timeline ordering', () => {
  it('createdAt ≤ scheduledAt for every non-requested tour (no wraparound)', () => {
    for (const t of TOURS) {
      if (tourStatusOf(t) === 'requested') continue;
      expect(
        ms(t['createdAt']),
        `tour ${t['tourId']}: createdAt > scheduledAt`,
      ).toBeLessThanOrEqual(ms(t['scheduledAt']));
    }
  });

  it('upcoming tours are future-dated; past tours are past-dated', () => {
    for (const t of TOURS) {
      const status = tourStatusOf(t);
      if (UPCOMING_TOUR.has(status)) {
        expect(ms(t['scheduledAt']), `upcoming ${t['tourId']} must be in the future`).toBeGreaterThan(NOW_MS);
      } else if (PAST_TOUR.has(status)) {
        expect(ms(t['scheduledAt']), `past ${t['tourId']} must be in the past`).toBeLessThan(NOW_MS);
      }
    }
  });

  it('every reminder respects createdAt ≤ dueAt ≤ (sentAt ?? canceledAt ?? ∞)', () => {
    expect(TOUR_REMINDERS.length).toBeGreaterThanOrEqual(1);
    for (const r of TOUR_REMINDERS) {
      const created = ms(r['createdAt']);
      const due = ms(r['dueAt']);
      expect(created, `reminder ${r['reminderId']}: createdAt > dueAt`).toBeLessThanOrEqual(due);
      expect(due, `reminder ${r['reminderId']}: dueAt > terminal (sentAt/canceledAt)`).toBeLessThanOrEqual(terminalMs(r));
    }
  });
});

describe('matrix coherence: the load-bearing live-fire invariant', () => {
  it('NO pending reminder has dueAt < now (would live-fire on the next poll)', () => {
    const offenders = TOUR_REMINDERS.filter((r) => isPending(r) && ms(r['dueAt']) < NOW_MS);
    expect(
      offenders.map((r) => `${r['reminderId']}@${r['dueAt']}`),
      'pending reminders with dueAt in the past would be re-sent by runDueTourReminders',
    ).toEqual([]);
  });

  it('upcoming tours have a PENDING day_before whose dueAt ≥ now; past tours have ALL reminders terminal', () => {
    for (const t of TOURS) {
      const status = tourStatusOf(t);
      const rems = remindersOf(t['tourId'] as string);
      if (UPCOMING_TOUR.has(status)) {
        const dayBefore = rems.find((r) => r['kind'] === 'day_before');
        expect(dayBefore, `upcoming ${t['tourId']} must have a day_before reminder`).toBeDefined();
        expect(isPending(dayBefore!), `upcoming ${t['tourId']} day_before must be pending`).toBe(true);
        expect(ms(dayBefore!['dueAt']), `upcoming ${t['tourId']} day_before dueAt ≥ now`).toBeGreaterThanOrEqual(NOW_MS);
      } else if (PAST_TOUR.has(status)) {
        for (const r of rems) {
          expect(isPending(r), `past ${t['tourId']} reminder ${r['reminderId']} must be terminal`).toBe(false);
        }
      }
    }
  });

  it('no_show tours carry a sent no_show_checkin at scheduledAt + 30m', () => {
    const noShows = TOURS.filter((t) => tourStatusOf(t) === 'no_show');
    expect(noShows.length).toBeGreaterThanOrEqual(2);
    for (const t of noShows) {
      const nsc = remindersOf(t['tourId'] as string).find((r) => r['kind'] === 'no_show_checkin');
      expect(nsc, `no_show ${t['tourId']} must have a no_show_checkin`).toBeDefined();
      expect(nsc!['sentAt'], `no_show_checkin ${t['tourId']} must be sent`).toBeDefined();
      expect(ms(nsc!['dueAt']) - ms(t['scheduledAt']), `no_show_checkin dueAt offset`).toBe(30 * 60 * 1000);
    }
  });
});

describe('matrix coherence: convertible representation is consistent (toured ↔ closed)', () => {
  it('every toured/closed tour sets outcome+moveForward+convertible with convertible === (moveForward===true)', () => {
    const decided = TOURS.filter((t) => tourStatusOf(t) === 'toured' || tourStatusOf(t) === 'closed');
    expect(decided.length, 'expected ≥4 decided tours (toured×2 + closed×2)').toBeGreaterThanOrEqual(4);
    for (const t of decided) {
      expect(t['outcome'], `${t['tourId']} must have an outcome`).toBeDefined();
      expect(typeof t['moveForward'], `${t['tourId']} moveForward is a boolean`).toBe('boolean');
      // The unified shape: convertible mirrors the moveForward decision (what the
      // conversion route + /tours UI read).
      expect(t['convertible'], `${t['tourId']} convertible must mirror moveForward`).toBe(t['moveForward'] === true);
      const expectedOutcome = t['moveForward'] === true ? 'move_forward' : 'not_a_fit';
      expect(t['outcome'], `${t['tourId']} outcome ↔ moveForward`).toBe(expectedOutcome);
    }
  });
});

// ---------------------------------------------------------------------------
// History coherence — the merged history.ts trails follow the now-relative
// placements automatically (findings §Interaction). No history.ts edit; we only
// assert its output over the now-relative matrix is now-relative + consistent.
// ---------------------------------------------------------------------------
describe('matrix coherence: generated history is now-relative + consistent with the placement', () => {
  const history = historyItems(ITEMS);
  const tsIso = (ts: unknown): string => String(ts).split('#')[0]!;

  it("a sample placement's audit trail ends at stage_entered_at and every hop is < now", () => {
    const sample = PLACEMENTS.find((p) => p['placementId'] === 'placement-mx-awaiting-inspection-01');
    expect(sample, 'sample placement must exist').toBeDefined();
    const trail = history.audit_events.filter(
      (r) => r.entityKey === `placements#${sample!['placementId']}` && r.event_type === 'placement_stage_changed',
    );
    expect(trail.length, 'sample placement must have a multi-hop trail').toBeGreaterThanOrEqual(2);
    const hopMs = trail.map((r) => Date.parse(tsIso(r.ts))).sort((a, b) => a - b);
    // Final hop == the now-relative stage_entered_at (the trail anchors on it).
    expect(hopMs[hopMs.length - 1]).toBe(ms(sample!['stage_entered_at']));
    // Every hop is strictly in the past, and monotonically increasing.
    for (let i = 0; i < hopMs.length; i++) {
      expect(hopMs[i], `hop ${i} must be < now`).toBeLessThan(NOW_MS);
      if (i > 0) expect(hopMs[i]!, `hop ${i} monotonic`).toBeGreaterThan(hopMs[i - 1]!);
    }
  });

  it("that tenant's activity timeline is now-relative (every milestone at < now, ≤ stage entry)", () => {
    const sample = PLACEMENTS.find((p) => p['placementId'] === 'placement-mx-awaiting-inspection-01')!;
    const tenantId = sample['tenantId'] as string;
    const timeline = history.activity_events.filter((r) => r.contactId === tenantId);
    expect(timeline.length, `tenant ${tenantId} must have milestones`).toBeGreaterThanOrEqual(1);
    for (const r of timeline) {
      expect(ms(r.at), `milestone ${r.eventId} at < now`).toBeLessThan(NOW_MS);
      expect(ms(r.at), `milestone ${r.eventId} at ≤ stage_entered_at`).toBeLessThanOrEqual(ms(sample['stage_entered_at']));
    }
  });
});
