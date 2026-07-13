// Seed tour audit-trail coherence (Task 1) - guards the tours# lifecycle rows
// that history.ts materializes in the FULL seed profile so every seeded tour's
// detail-page panes + Activity card render its lifecycle (not comms-only).
//
// Mirrors seedMatrixCoherence.test.ts / seedRosterShape.test.ts conventions:
// DB-free assertions over the in-memory assembled map, deterministic given a
// FIXED now. The generator (tourTrail) is derived from the live writer's event
// vocabulary + per-status sequences (spec 2026-07-13-seed-tour-audit-trails);
// this file pins those so drift fails loudly.
import { describe, expect, it } from 'vitest';
import { SEED } from '../src/lib/seed/lean.js';
import { castItems } from '../src/lib/seed/cast.js';
import { matrixItems } from '../src/lib/seed/matrix.js';
import { tourTrail, historyItems, tourMilestones, type AuditRow } from '../src/lib/seed/history.js';

// A fixed clock so matrixItems(now) is fully deterministic.
const FIXED_NOW = new Date('2026-07-03T12:00:00.000Z');
const NOW_MS = FIXED_NOW.getTime();

type Row = Record<string, unknown>;

// The FULL assembled map, exactly as seedAll('full') builds it (lean + cast +
// matrix, additive by table). historyItems runs over this.
function assembleFull(now: Date): Record<string, Row[]> {
  const tables: Record<string, Row[]> = {};
  for (const [base, items] of Object.entries(SEED)) tables[base] = [...items];
  for (const [base, items] of Object.entries(castItems())) {
    tables[base] = [...(tables[base] ?? []), ...items];
  }
  for (const [base, items] of Object.entries(matrixItems(now))) {
    tables[base] = [...(tables[base] ?? []), ...items];
  }
  return tables;
}

const FULL = assembleFull(FIXED_NOW);
const TOURS = FULL['tours'] ?? [];

const tourIdOf = (t: Row) => String(t['tourId'] ?? '');
const statusOf = (t: Row) => String(t['status'] ?? '');
const tourById = new Map(TOURS.map((t) => [tourIdOf(t), t]));

// tours# audit rows for one tour, from the assembled-map history post-pass.
const HISTORY = historyItems(FULL);
const tourRowsFor = (tourId: string): AuditRow[] =>
  HISTORY.audit_events.filter((r) => r.entityKey === `tours#${tourId}`);

const isoOf = (ts: unknown): string => String(ts).split('#')[0]!;
const msOf = (ts: unknown): number => Date.parse(isoOf(ts));
const typesOf = (rows: AuditRow[]): string[] => rows.map((r) => r.event_type);

// ---------------------------------------------------------------------------
// The pinned 8-type vocabulary. This literal list MIRRORS the dashboard's
// tourActivityFormat.ts TOUR_EVENT_LABELS keys (the dashboard module is not
// importable from app tests). If the dashboard label map changes, this pin must
// change with it - a deliberate drift alarm. Seeded rows may ONLY use these
// types so no unknown-type fallback ever renders.
// ---------------------------------------------------------------------------
const TOUR_EVENT_LABEL_KEYS = [
  'tour_scheduled',
  'tour_rescheduled',
  'tour_took_place',
  'tour_no_show',
  'tour_canceled',
  'tour_outcome',
  'tour_group_opened',
  'tour_converted',
] as const;
const TOUR_EVENT_LABEL_SET = new Set<string>(TOUR_EVENT_LABEL_KEYS);

// ---------------------------------------------------------------------------
// 1. Non-requested tours have a non-empty trail; requested tours have ZERO.
// ---------------------------------------------------------------------------
describe('seed tour trails: presence per status', () => {
  it('matrix produces the expected tour coverage (2 per status, incl. requested)', () => {
    expect(TOURS.length).toBeGreaterThanOrEqual(12);
  });

  it('every NON-requested seeded tour has a non-empty tours# trail', () => {
    const nonRequested = TOURS.filter((t) => statusOf(t) !== 'requested');
    expect(nonRequested.length, 'assembled map must include non-requested tours').toBeGreaterThanOrEqual(1);
    for (const t of nonRequested) {
      expect(
        tourRowsFor(tourIdOf(t)).length,
        `non-requested tour ${tourIdOf(t)} (${statusOf(t)}) must have a trail`,
      ).toBeGreaterThan(0);
    }
  });

  it('every REQUESTED seeded tour has ZERO tours# rows (even with a groupThreadId)', () => {
    const requested = TOURS.filter((t) => statusOf(t) === 'requested');
    expect(requested.length, 'assembled map must include requested tours').toBeGreaterThanOrEqual(1);
    // The cast searching-tenant requested tour carries a groupThreadId - it must
    // STILL emit zero rows (requested short-circuits before the appendices).
    const withGroup = requested.filter((t) => typeof t['groupThreadId'] === 'string');
    expect(withGroup.length, 'a requested tour with a groupThreadId must be exercised').toBeGreaterThanOrEqual(1);
    for (const t of requested) {
      expect(
        tourRowsFor(tourIdOf(t)).length,
        `requested tour ${tourIdOf(t)} must have zero rows`,
      ).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Every generated row's type is a key of the dashboard label map.
// ---------------------------------------------------------------------------
describe('seed tour trails: type vocabulary', () => {
  it('every generated tours# row type is one of the 8 dashboard TOUR_EVENT_LABELS keys', () => {
    const tourRows = HISTORY.audit_events.filter((r) => r.entityKey.startsWith('tours#'));
    expect(tourRows.length, 'assembled map must produce tour rows').toBeGreaterThan(0);
    for (const r of tourRows) {
      expect(
        TOUR_EVENT_LABEL_SET.has(r.event_type),
        `tour row type '${r.event_type}' must be a known TOUR_EVENT_LABELS key`,
      ).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Per-status sequence + payload shapes (spec section 3 exactly).
// ---------------------------------------------------------------------------
// Expected base body per status, plus per-field appendices.
const BASE_SEQUENCE: Record<string, string[]> = {
  scheduled: ['tour_scheduled'],
  toured: ['tour_scheduled', 'tour_took_place'],
  no_show: ['tour_scheduled', 'tour_no_show'],
  canceled: ['tour_scheduled', 'tour_canceled'],
  closed: ['tour_scheduled', 'tour_took_place'],
};

function expectedTypes(tour: Row): string[] {
  const status = statusOf(tour);
  if (status === 'requested') return [];
  const set = new Set<string>(BASE_SEQUENCE[status] ?? []);
  if (typeof tour['groupThreadId'] === 'string' && tour['groupThreadId'].length > 0) {
    set.add('tour_group_opened');
  }
  if (typeof tour['outcome'] === 'string' && tour['outcome'].length > 0) set.add('tour_outcome');
  if (typeof tour['convertedPlacementId'] === 'string' && tour['convertedPlacementId'].length > 0) {
    set.add('tour_converted');
  }
  return [...set].sort();
}

describe('seed tour trails: per-status sequence + payloads', () => {
  it('every non-requested tour emits exactly its status body + field appendices', () => {
    for (const t of TOURS) {
      if (statusOf(t) === 'requested') continue;
      const rows = tourRowsFor(tourIdOf(t));
      expect([...typesOf(rows)].sort(), `tour ${tourIdOf(t)} (${statusOf(t)}) type set`).toEqual(
        expectedTypes(t),
      );
    }
  });

  it('closed tours emit tour_took_place (a closed tour necessarily happened)', () => {
    const closed = TOURS.filter((t) => statusOf(t) === 'closed');
    expect(closed.length).toBeGreaterThanOrEqual(1);
    for (const t of closed) {
      expect(typesOf(tourRowsFor(tourIdOf(t))), `closed ${tourIdOf(t)}`).toContain('tour_took_place');
    }
  });

  it('payloads are { tourId } baseline; conversationId on group_opened; NO actor anywhere', () => {
    const tourRows = HISTORY.audit_events.filter((r) => r.entityKey.startsWith('tours#'));
    for (const r of tourRows) {
      // No actor - archive writes never carry one.
      expect(r.actorId, `${r.event_type} must have no actorId`).toBeUndefined();
      expect(r.payload['actor'], `${r.event_type} payload must have no actor`).toBeUndefined();
      expect(typeof r.payload['tourId'], `${r.event_type} payload needs a tourId`).toBe('string');
      if (r.event_type === 'tour_group_opened') {
        expect(typeof r.payload['conversationId'], 'group_opened needs a conversationId').toBe('string');
        expect(r.payload['placementId'], 'group_opened has no placementId').toBeUndefined();
      } else if (r.event_type === 'tour_converted') {
        expect(typeof r.payload['placementId'], 'converted needs a placementId').toBe('string');
      } else {
        // baseline rows: exactly { tourId }.
        expect(Object.keys(r.payload).sort(), `${r.event_type} payload is { tourId } only`).toEqual(['tourId']);
      }
    }
  });

  it('the cast toured tour emits scheduled + group_opened + took_place + outcome, ordered', () => {
    const t = tourById.get('tour-cast-toured-yes-tenant');
    expect(t, 'cast toured tour must exist').toBeDefined();
    const rows = tourTrail(t!);
    expect(typesOf(rows)).toEqual([
      'tour_scheduled',
      'tour_group_opened',
      'tour_took_place',
      'tour_outcome',
    ]);
    // group_opened carries the tour's groupThreadId as conversationId.
    const grp = rows.find((r) => r.event_type === 'tour_group_opened')!;
    expect(grp.payload['conversationId']).toBe(t!['groupThreadId']);
  });

  it('a synthetic tour with convertedPlacementId emits a tour_converted row after took_place', () => {
    const synthetic: Row = {
      tourId: 'tour-synth-converted-01',
      tenantId: 'contact-synth-01',
      unitId: 'unit-synth-01',
      status: 'closed',
      tourType: 'landlord_led',
      scheduledAt: '2026-06-01T18:00:00.000Z',
      createdAt: '2026-05-30T10:00:00.000Z',
      updatedAt: '2026-06-01T21:00:00.000Z',
      outcome: 'move_forward',
      moveForward: true,
      convertedPlacementId: 'placement-synth-01',
    };
    const rows = tourTrail(synthetic);
    const converted = rows.find((r) => r.event_type === 'tour_converted');
    expect(converted, 'synthetic tour must emit tour_converted').toBeDefined();
    expect(converted!.payload).toEqual({ tourId: 'tour-synth-converted-01', placementId: 'placement-synth-01' });
    expect(converted!.actorId, 'converted carries no actor').toBeUndefined();
    // Conversion is the final chapter - after took_place (== scheduledAt).
    const tookPlace = rows.find((r) => r.event_type === 'tour_took_place')!;
    expect(msOf(converted!.ts), 'converted after took_place').toBeGreaterThan(msOf(tookPlace.ts));
    // The row set is monotonically non-decreasing (final row is the converted one).
    expect(rows[rows.length - 1]!.event_type).toBe('tour_converted');
  });
});

// ---------------------------------------------------------------------------
// 4. Timestamp coherence.
// ---------------------------------------------------------------------------
describe('seed tour trails: timestamp coherence', () => {
  it('booking (tour_scheduled) is in [createdAt, scheduledAt) for every non-requested tour', () => {
    for (const t of TOURS) {
      if (statusOf(t) === 'requested') continue;
      const rows = tourRowsFor(tourIdOf(t));
      const scheduled = rows.find((r) => r.event_type === 'tour_scheduled')!;
      const bookingMs = msOf(scheduled.ts);
      const createdMs = Date.parse(String(t['createdAt']));
      const schedMs = Date.parse(String(t['scheduledAt']));
      expect(bookingMs, `${tourIdOf(t)} booking >= createdAt`).toBeGreaterThanOrEqual(createdMs);
      expect(bookingMs, `${tourIdOf(t)} booking < scheduledAt`).toBeLessThan(schedMs);
    }
  });

  it('tour_took_place / tour_no_show land exactly at scheduledAt', () => {
    for (const t of TOURS) {
      const status = statusOf(t);
      if (status === 'requested' || status === 'scheduled' || status === 'canceled') continue;
      const rows = tourRowsFor(tourIdOf(t));
      const schedMs = Date.parse(String(t['scheduledAt']));
      const visit = rows.find((r) => r.event_type === 'tour_took_place' || r.event_type === 'tour_no_show');
      expect(visit, `${tourIdOf(t)} (${status}) must have a visit row`).toBeDefined();
      expect(msOf(visit!.ts), `${tourIdOf(t)} visit == scheduledAt`).toBe(schedMs);
    }
  });

  it('tour_canceled lands on/before scheduledAt', () => {
    const canceled = TOURS.filter((t) => statusOf(t) === 'canceled');
    expect(canceled.length).toBeGreaterThanOrEqual(1);
    for (const t of canceled) {
      const rows = tourRowsFor(tourIdOf(t));
      const cancel = rows.find((r) => r.event_type === 'tour_canceled')!;
      const schedMs = Date.parse(String(t['scheduledAt']));
      expect(msOf(cancel.ts), `${tourIdOf(t)} canceled <= scheduledAt`).toBeLessThanOrEqual(schedMs);
    }
  });

  it('rows are monotonically non-decreasing in instant per tour', () => {
    for (const t of TOURS) {
      const rows = tourRowsFor(tourIdOf(t));
      for (let i = 1; i < rows.length; i++) {
        expect(msOf(rows[i]!.ts), `${tourIdOf(t)} row ${i} monotonic`).toBeGreaterThanOrEqual(
          msOf(rows[i - 1]!.ts),
        );
      }
    }
  });

  it('every matrix/cast tour instant is <= now', () => {
    const tourRows = HISTORY.audit_events.filter((r) => r.entityKey.startsWith('tours#'));
    for (const r of tourRows) {
      expect(msOf(r.ts), `${r.entityKey} ${r.event_type} instant <= now`).toBeLessThanOrEqual(NOW_MS);
    }
  });

  it('distinct SK suffixes when two rows share an instant (group_opened at booking)', () => {
    const t = tourById.get('tour-cast-toured-yes-tenant')!;
    const rows = tourTrail(t);
    const scheduled = rows.find((r) => r.event_type === 'tour_scheduled')!;
    const grp = rows.find((r) => r.event_type === 'tour_group_opened')!;
    expect(isoOf(scheduled.ts), 'scheduled + group_opened share the booking instant').toBe(isoOf(grp.ts));
    expect(scheduled.ts, 'but the full SKs differ (distinct suffix)').not.toBe(grp.ts);
  });
});

// ---------------------------------------------------------------------------
// 5. Byte-stability (deterministic on fixed inputs).
// ---------------------------------------------------------------------------
describe('seed tour trails: byte-stability', () => {
  it('tourTrail over a fixed cast tour deep-equals itself across two calls', () => {
    const t = tourById.get('tour-cast-toured-yes-tenant')!;
    expect(tourTrail(t)).toEqual(tourTrail(t));
  });

  it('matrixItems(fixedNow) tour trails deep-equal across two assemblies', () => {
    const a = historyItems(assembleFull(FIXED_NOW)).audit_events.filter((r) => r.entityKey.startsWith('tours#'));
    const b = historyItems(assembleFull(FIXED_NOW)).audit_events.filter((r) => r.entityKey.startsWith('tours#'));
    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 6. Alignment with the tenant-timeline tourMilestones (one clock).
// ---------------------------------------------------------------------------
describe('seed tour trails: alignment with tourMilestones', () => {
  it('booking + took-place instants equal the tourMilestones activity instants', () => {
    for (const t of TOURS) {
      if (statusOf(t) === 'requested') continue;
      const trail = tourTrail(t);
      const milestones = tourMilestones(t);
      const booking = trail.find((r) => r.event_type === 'tour_scheduled');
      const mBooking = milestones.find((m) => m.type === 'tour_scheduled');
      if (booking && mBooking) {
        expect(isoOf(booking.ts), `${tourIdOf(t)} booking instant aligns`).toBe(mBooking.at);
      }
      const took = trail.find((r) => r.event_type === 'tour_took_place');
      const mTook = milestones.find((m) => m.type === 'tour_took_place');
      if (took && mTook) {
        expect(isoOf(took.ts), `${tourIdOf(t)} took-place instant aligns`).toBe(mTook.at);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Defensive: malformed tours contribute nothing.
// ---------------------------------------------------------------------------
describe('seed tour trails: defensive skips', () => {
  it('no tourId, unknown status, or scheduled-status without scheduledAt -> zero rows', () => {
    expect(tourTrail({ status: 'toured', scheduledAt: '2026-06-01T00:00:00.000Z', createdAt: '2026-05-30T00:00:00.000Z' })).toEqual([]);
    expect(tourTrail({ tourId: 't1', status: 'bogus', scheduledAt: '2026-06-01T00:00:00.000Z' })).toEqual([]);
    expect(tourTrail({ tourId: 't2', status: 'toured', createdAt: '2026-05-30T00:00:00.000Z' })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 7. Lean untouched: lean has no tours, so no tour rows leak into its world.
// ---------------------------------------------------------------------------
describe('seed tour trails: lean profile untouched', () => {
  it('lean SEED produces no tours# audit rows', () => {
    const leanTables: Record<string, Row[]> = {};
    for (const [base, items] of Object.entries(SEED)) leanTables[base] = [...items];
    const rows = historyItems(leanTables).audit_events.filter((r) => r.entityKey.startsWith('tours#'));
    expect(rows).toEqual([]);
  });
});
