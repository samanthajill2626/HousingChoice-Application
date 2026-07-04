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
  STAGE_STUCK_THRESHOLDS,
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

// placement-deadline-model: deadlines are first-class placementDeadlines items,
// not raw next_deadline_* fields on the placement. Each active placement carries
// exactly one item; terminal (moved_in/lost) placements carry none. The coherence
// assertions below join a placement to its item by placementId.
const DEADLINES = ITEMS['placementDeadlines'] ?? [];
const deadlineOf = new Map(DEADLINES.map((d) => [d['placementId'] as string, d]));

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
    // No first-class deadline item is a tour_reminder…
    for (const d of DEADLINES) {
      expect(d['type'], `deadline ${d['deadlineId']} must not be tour_reminder`).not.toBe('tour_reminder');
    }
    // …and no placement carries a raw next_deadline slot at all (retired).
    for (const p of PLACEMENTS) {
      expect(
        p['next_deadline_type'],
        `placement ${p['placementId']} carries no raw next_deadline slot`,
      ).toBeUndefined();
    }
  });

  it('every deadline item has a type valid for its placement phase', () => {
    for (const d of DEADLINES) {
      const p = PLACEMENTS.find((x) => x['placementId'] === d['placementId']);
      expect(p, `deadline ${d['deadlineId']} must join a placement`).toBeDefined();
      const dt = d['type'] as string;
      const phase = STAGE_PHASE[stageOf(p!)];
      const valid = PHASE_DEADLINE_TYPES[phase] as readonly string[];
      expect(
        valid.includes(dt),
        `placement ${p!['placementId']} (${stageOf(p!)}/${phase}): '${dt}' ∉ [${valid.join(', ')}]`,
      ).toBe(true);
    }
  });

  it('rta_window appears ONLY on RTA-phase placements', () => {
    for (const d of DEADLINES) {
      if (d['type'] !== 'rta_window') continue;
      const p = PLACEMENTS.find((x) => x['placementId'] === d['placementId'])!;
      expect(STAGE_PHASE[stageOf(p)], `rta_window on ${p['placementId']}`).toBe('RTA');
    }
  });
});

// ---------------------------------------------------------------------------
// Deadline DATE ≥ stage entry (the −130-day impossibility must be gone)
// ---------------------------------------------------------------------------
describe('matrix coherence: deadline date ≥ stage_entered_at', () => {
  it('every deadline is on/after the placement entered its stage', () => {
    for (const d of DEADLINES) {
      const p = PLACEMENTS.find((x) => x['placementId'] === d['placementId'])!;
      expect(
        ms(d['at']),
        `placement ${p['placementId']}: deadline at < stage_entered_at`,
      ).toBeGreaterThanOrEqual(ms(p['stage_entered_at']));
    }
  });

  it('every attention-flagged deadline is OVERDUE (< now)', () => {
    // Attention is DECOUPLED from overdue-ness (quadrant model): a flagged row is
    // always overdue (it's already in needs_you_now, an overdue hard clock), so
    // "attention ⟹ overdue" still holds. The REVERSE ("non-flagged ⟹ upcoming")
    // is intentionally GONE — an overdue `follow_up` (due_followup role) is NOT
    // flagged yet lands in follow_ups. Quadrant coverage is asserted below.
    const withDeadline = PLACEMENTS.filter((p) => deadlineOf.has(p['placementId'] as string));
    expect(withDeadline.length, 'matrix must include deadline-bearing placements').toBeGreaterThanOrEqual(1);
    for (const p of withDeadline) {
      if (p['attention'] === undefined) continue;
      const dueMs = ms(deadlineOf.get(p['placementId'] as string)!['at']);
      expect(dueMs, `flagged placement ${p['placementId']} must be overdue (< now)`).toBeLessThan(NOW_MS);
    }
  });

  it('attention-flagged active placements are genuinely overdue (deadline in the recent past)', () => {
    const flagged = PLACEMENTS.filter((p) => isActive(p) && p['attention'] !== undefined);
    expect(flagged.length, 'matrix must include ≥1 attention-flagged placement').toBeGreaterThanOrEqual(1);
    for (const p of flagged) {
      const dueMs = ms(deadlineOf.get(p['placementId'] as string)!['at']);
      expect(dueMs, `attention placement ${p['placementId']} must be past-due`).toBeLessThan(NOW_MS);
      // …but only by DAYS, not months (no more Jan-dated deadlines in July).
      const daysPast = (NOW_MS - dueMs) / (24 * 60 * 60 * 1000);
      expect(daysPast, `attention placement ${p['placementId']} overdue by ${daysPast}d`).toBeLessThan(30);
    }
  });
});

// ---------------------------------------------------------------------------
// Deliberate deadline×stuck QUADRANT coverage (the headline of this rewrite)
// ---------------------------------------------------------------------------
describe('matrix coherence: deadline×stuck quadrant coverage', () => {
  // Derive stuck EXACTLY as today.ts does (now − stage_entered_at ≥ threshold).
  const isStuck = (p: Record<string, unknown>): boolean => {
    const threshold = STAGE_STUCK_THRESHOLDS[stageOf(p)];
    if (threshold === undefined) return false;
    const entered = ms(p['stage_entered_at']);
    return !Number.isNaN(entered) && NOW_MS - entered >= threshold;
  };
  const hasDeadline = (p: Record<string, unknown>): boolean => deadlineOf.has(p['placementId'] as string);
  const actives = PLACEMENTS.filter(isActive);

  it('covers all FOUR quadrants ≥1 each (deadline×stuck)', () => {
    const deadlineNotStuck = actives.filter((p) => hasDeadline(p) && !isStuck(p));
    const stuckNoDeadline = actives.filter((p) => !hasDeadline(p) && isStuck(p));
    const both = actives.filter((p) => hasDeadline(p) && isStuck(p));
    const neither = actives.filter((p) => !hasDeadline(p) && !isStuck(p));
    expect(deadlineNotStuck.length, 'quadrant (a) deadline & not stuck').toBeGreaterThanOrEqual(1);
    expect(stuckNoDeadline.length, 'quadrant (b) stuck & no deadline').toBeGreaterThanOrEqual(1);
    expect(both.length, 'quadrant (c) both deadline & stuck').toBeGreaterThanOrEqual(1);
    expect(neither.length, 'quadrant (d) neither').toBeGreaterThanOrEqual(1);
  });

  it('has a due HARD-CLOCK example: an overdue rta_window/voucher on a NON-stuck App/RTA placement', () => {
    const hardClock = actives.filter((p) => {
      if (isStuck(p)) return false;
      const d = deadlineOf.get(p['placementId'] as string);
      if (!d) return false;
      const type = d['type'] as string;
      return (type === 'rta_window' || type === 'voucher_expiration') && ms(d['at']) < NOW_MS;
    });
    expect(hardClock.length, 'a due, non-stuck hard-clock placement (needs_you_now, not follow_ups)').toBeGreaterThanOrEqual(1);
  });

  it('has a stuck-no-deadline example (follow_ups via DERIVED stuck only)', () => {
    const stuckOnly = actives.filter((p) => isStuck(p) && !hasDeadline(p));
    expect(stuckOnly.length, 'a derived-stuck placement carrying NO deadline item').toBeGreaterThanOrEqual(1);
  });

  it('has an OVERDUE follow_up that is NOT attention-flagged (lands in follow_ups only)', () => {
    // The key decoupling fix: an overdue follow_up must not be attention-flagged.
    const overdueUnflaggedFollowup = actives.filter((p) => {
      const d = deadlineOf.get(p['placementId'] as string);
      if (!d || d['type'] !== 'follow_up') return false;
      return ms(d['at']) < NOW_MS && p['attention'] === undefined;
    });
    expect(overdueUnflaggedFollowup.length, 'an overdue, UNFLAGGED follow_up').toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Voucher coherence: voucher_expiration deadline ⟺ tenant.voucher_expiration_date
// ---------------------------------------------------------------------------
describe('matrix coherence: voucher_expiration_date ⟺ voucher deadline', () => {
  const tenantsById = new Map(
    (ITEMS['contacts'] ?? [])
      .filter((c) => c['type'] === 'tenant')
      .map((c) => [c['contactId'] as string, c]),
  );
  const placementById = new Map(PLACEMENTS.map((p) => [p['placementId'] as string, p]));

  it('every voucher_expiration deadline pins its tenant voucher_expiration_date to deadline.at', () => {
    const voucherDeadlines = DEADLINES.filter((d) => d['type'] === 'voucher_expiration');
    expect(voucherDeadlines.length, 'matrix must include ≥1 voucher_expiration deadline').toBeGreaterThanOrEqual(1);
    for (const d of voucherDeadlines) {
      const p = placementById.get(d['placementId'] as string);
      expect(p, `voucher deadline ${d['deadlineId']} must join a placement`).toBeDefined();
      const t = tenantsById.get(p!['tenantId'] as string);
      expect(t, `tenant for ${p!['placementId']} must exist`).toBeDefined();
      expect(t!['voucher_expiration_date'], `tenant for ${p!['placementId']} voucher_expiration_date == deadline.at`).toBe(d['at']);
    }
  });

  it('NO tenant carries voucher_expiration_date unless its placement has a voucher_expiration deadline', () => {
    // Build the set of tenantIds whose placement carries a voucher deadline.
    const voucherTenantIds = new Set(
      DEADLINES.filter((d) => d['type'] === 'voucher_expiration')
        .map((d) => placementById.get(d['placementId'] as string))
        .filter((p): p is Record<string, unknown> => p !== undefined)
        .map((p) => p['tenantId'] as string),
    );
    for (const t of tenantsById.values()) {
      if (t['voucher_expiration_date'] === undefined) continue;
      expect(
        voucherTenantIds.has(t['contactId'] as string),
        `tenant ${t['contactId']} carries voucher_expiration_date but its placement has NO voucher deadline`,
      ).toBe(true);
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
    const present = new Set(DEADLINES.map((d) => d['type'] as string));
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
    const collectRta = PLACEMENTS.filter((p) => stageOf(p) === 'collect_rta' && deadlineOf.has(p['placementId'] as string));
    expect(collectRta.length, 'expected ≥1 deadline-bearing collect_rta placement').toBeGreaterThanOrEqual(1);
    for (const p of collectRta) {
      const d = deadlineOf.get(p['placementId'] as string)!;
      const dt = d['type'] as string;
      expect(dt).not.toBe('tour_reminder');
      expect((PHASE_DEADLINE_TYPES['RTA'] as readonly string[]).includes(dt), `collect_rta deadline '${dt}' must be RTA-valid`).toBe(true);
      expect(ms(d['at'])).toBeGreaterThanOrEqual(ms(p['stage_entered_at']));
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
  it('NO pending reminder has dueAt ≤ now (would live-fire on the next poll)', () => {
    // tourRemindersRepo.listDue fires on dueAt <= now (INCLUSIVE), so a pending
    // reminder whose dueAt is EXACTLY now would still be re-sent — flag <= now, not < now.
    const offenders = TOUR_REMINDERS.filter((r) => isPending(r) && ms(r['dueAt']) <= NOW_MS);
    expect(
      offenders.map((r) => `${r['reminderId']}@${r['dueAt']}`),
      'pending reminders with dueAt ≤ now would be re-sent by runDueTourReminders',
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
        // Strict > now: at exactly now the reminder would live-fire (listDue is dueAt<=now).
        expect(ms(dayBefore!['dueAt']), `upcoming ${t['tourId']} day_before dueAt > now`).toBeGreaterThan(NOW_MS);
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
  it('toured/closed set outcome+moveForward; toured mirrors convertible; closed is never convertible', () => {
    const decided = TOURS.filter((t) => tourStatusOf(t) === 'toured' || tourStatusOf(t) === 'closed');
    expect(decided.length, 'expected ≥4 decided tours (toured×2 + closed×2)').toBeGreaterThanOrEqual(4);
    for (const t of decided) {
      expect(t['outcome'], `${t['tourId']} must have an outcome`).toBeDefined();
      expect(typeof t['moveForward'], `${t['tourId']} moveForward is a boolean`).toBe('boolean');
      const expectedOutcome = t['moveForward'] === true ? 'move_forward' : 'not_a_fit';
      expect(t['outcome'], `${t['tourId']} outcome ↔ moveForward`).toBe(expectedOutcome);
      if (tourStatusOf(t) === 'toured') {
        // A `toured` tour is the ready-to-convert state: convertible mirrors moveForward.
        expect(t['convertible'], `toured ${t['tourId']} convertible must mirror moveForward`).toBe(t['moveForward'] === true);
      } else {
        // A `closed` tour is terminal/already-decided — convertible must be falsy,
        // never true (see the regression assertion below).
        expect(t['convertible'], `closed ${t['tourId']} must not be convertible`).toBeFalsy();
      }
    }
  });

  it('NO closed tour is convertible (pins the orphan-placement regression)', () => {
    // Both placements.ts POST /placements/from-tour and TourDetail's "Start placement"
    // button gate SOLELY on convertible===true && convertedPlacementId===undefined
    // (no status gate). A convertible closed tour would therefore show a live button
    // and create an orphan placement — this asserts that can never be seeded.
    const closed = TOURS.filter((t) => tourStatusOf(t) === 'closed');
    expect(closed.length, 'expected ≥2 closed tours').toBeGreaterThanOrEqual(2);
    for (const t of closed) {
      expect(t['convertible'], `closed ${t['tourId']} convertible`).not.toBe(true);
    }
  });

  it('≥1 toured tour remains convertible (ready-to-convert coverage preserved)', () => {
    const convertibleToured = TOURS.filter(
      (t) => tourStatusOf(t) === 'toured' && t['convertible'] === true,
    );
    expect(convertibleToured.length, 'toured rep1 must remain convertible').toBeGreaterThanOrEqual(1);
  });

  it('toured/closed record their exit-gate decision post-visit (scheduledAt < updatedAt ≤ now)', () => {
    const decided = TOURS.filter((t) => tourStatusOf(t) === 'toured' || tourStatusOf(t) === 'closed');
    expect(decided.length).toBeGreaterThanOrEqual(4);
    for (const t of decided) {
      // createdAt ≤ scheduledAt ≤ updatedAt ≤ now, with the decision strictly after the visit.
      expect(ms(t['createdAt']), `${t['tourId']}: createdAt ≤ scheduledAt`).toBeLessThanOrEqual(ms(t['scheduledAt']));
      expect(ms(t['updatedAt']), `${t['tourId']}: updatedAt > scheduledAt`).toBeGreaterThan(ms(t['scheduledAt']));
      expect(ms(t['updatedAt']), `${t['tourId']}: updatedAt ≤ now`).toBeLessThanOrEqual(NOW_MS);
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
