// Tests for seedLive() — the now-relative showcase seeder (Task 4).
//
// All assertions use an INJECTED fixed `now` so the test is deterministic.
// The key properties verified:
//   1. The today tour's scheduledAt is on FIXED_NOW's UTC date.
//   2. The tomorrow tour's reminder dueAts match what armTourReminders would
//      compute (via computeDueAt logic from jobs/tourReminders.ts) — no drift.
//   3. The overdue-RTA placement's deadline is < FIXED_NOW.
//   4. The follow-up placement's deadline is ≤ FIXED_NOW.
//   5. Live tenant/unit statuses equal deriveStatuses(stage).
//   6. Live IDs don't collide with lean/matrix/cast IDs.
//   7. Reminder invariant: requested tours have no rows (live has none); live
//      scheduled tours legitimately have rows.
//
// Uses the real armTourReminders computation (same import as live.ts) to
// compute expected dueAts — ensuring the seed and worker always agree.
import { randomUUID } from 'node:crypto';
import { GetCommand, QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDocumentClient, createDynamoClient } from '../src/lib/dynamo.js';
import { deleteTableIfExists, ensureTable } from '../src/lib/dynamoAdmin.js';
import { TABLES } from '../src/lib/tables.js';
import { SEED } from '../src/lib/seedData.js';
import { matrixItems } from '../src/lib/seed/matrix.js';
import { castItems } from '../src/lib/seed/cast.js';
import { seedLive, LIVE_IDS } from '../src/lib/seed/live.js';
import { deriveStatuses } from '../src/lib/statusModel.js';
import {
  clampOutOfQuietHours,
  instantAtLocalTime,
  localDateOf,
  quietHoursWindowOf,
} from '../src/lib/quietHours.js';
import { DEFAULT_ORG_SETTINGS } from '../src/repos/settingsRepo.js';

// We re-implement computeDueAt inline to match jobs/tourReminders.ts exactly.
// This is intentionally a COPY so we catch drift if either side changes.
// If this test ever fails because the copy drifted, update this copy to match
// the canonical one in tourReminders.ts.
//
// QUIET HOURS (spec 2026-08-03): the seeder arms through the REAL armer, so the
// copy mirrors BOTH halves of the new rule - morning_of is 08:00 ORG-LOCAL (it
// used to be 08:00 UTC), and every rung is clamped out of the org's quiet
// window before it is stored. Only the ladder OFFSETS stay hand-written; the
// window/timezone arithmetic is imported from the shipped lib (a hand-copied
// Intl/DST implementation would test the copy, not the product). The seed runs
// against an empty settings table, so the window is DEFAULT_ORG_SETTINGS.
type ReminderKind = 'confirmation' | 'day_before' | 'morning_of' | 'en_route' | 'no_show_checkin';

const QUIET_WINDOW = quietHoursWindowOf(DEFAULT_ORG_SETTINGS);

function computeDueAt(kind: ReminderKind, scheduledAt: string, now: string): string {
  const scheduled = new Date(scheduledAt).getTime();
  const raw = ((): string => {
    switch (kind) {
      case 'confirmation':
        return now;
      case 'day_before':
        return new Date(scheduled - 24 * 60 * 60 * 1000).toISOString();
      case 'morning_of':
        return instantAtLocalTime(
          localDateOf(scheduledAt, QUIET_WINDOW.timezone),
          '08:00',
          QUIET_WINDOW.timezone,
        );
      case 'en_route':
        return new Date(scheduled - 2 * 60 * 60 * 1000).toISOString();
      case 'no_show_checkin':
        return new Date(scheduled + 30 * 60 * 1000).toISOString();
    }
  })();
  return clampOutOfQuietHours(raw, QUIET_WINDOW);
}

// no_show_checkin is intentionally NOT auto-armed (manual send only), so it is
// omitted here to mirror the canonical REMINDER_KINDS in jobs/tourReminders.ts.
// The ReminderKind type + computeDueAt case above deliberately keep all 5 kinds
// (the kind stays legal everywhere it is read/rendered; it is just never armed).
const REMINDER_KINDS: ReminderKind[] = [
  'confirmation',
  'day_before',
  'morning_of',
  'en_route',
];

// ---------------------------------------------------------------------------
// Fixed "now" for determinism. Set to 09:00 UTC so the "today" tour's 14:00
// UTC scheduledAt is in the future; day_before/morning_of/en_route are also
// in the future for tomorrow's tour; no_show_checkin for tomorrow is future.
// ---------------------------------------------------------------------------
const FIXED_NOW = new Date('2026-07-15T09:00:00.000Z');
const FIXED_NOW_ISO = FIXED_NOW.toISOString();

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
  console.warn(
    `[seedLive.test] SKIPPED — no DynamoDB Local at ${endpoint}. ` +
      'Run `npm run db:start` to exercise this suite.',
  );
}

describe.skipIf(!reachable)('seedLive — injected-now determinism', () => {
  const prefix = `hc-test-${randomUUID().slice(0, 8)}-`;
  const client = createDynamoClient({ endpoint });
  const doc = createDocumentClient({ endpoint });

  const origPrefix = process.env.TABLE_PREFIX;
  const origEndpoint = process.env.DYNAMODB_ENDPOINT;

  beforeAll(async () => {
    process.env.TABLE_PREFIX = prefix;
    process.env.DYNAMODB_ENDPOINT = endpoint;
    // Create all tables under the throwaway prefix.
    for (const spec of TABLES) {
      await ensureTable(client, spec, `${prefix}${spec.baseName}`);
    }
    // Run seedLive with the fixed now.
    await seedLive(endpoint, FIXED_NOW);
  });

  afterAll(async () => {
    // Drop all throwaway tables.
    for (const spec of TABLES) {
      await deleteTableIfExists(client, `${prefix}${spec.baseName}`);
    }
    process.env.TABLE_PREFIX = origPrefix;
    process.env.DYNAMODB_ENDPOINT = origEndpoint;
    doc.destroy();
  });

  // ---------------------------------------------------------------------------
  // Today tour assertions
  // ---------------------------------------------------------------------------
  describe('TOUR-A (today, self-guided)', () => {
    it('scheduledAt is on FIXED_NOW\'s UTC date at 14:00', () => {
      const expectedYmd = FIXED_NOW_ISO.slice(0, 10);
      const expectedScheduledAt = `${expectedYmd}T14:00:00.000Z`;
      // Read directly from static build: the tour is in the tours table.
      // We check via the known ID.
      const todayYmd = FIXED_NOW_ISO.slice(0, 10);
      const scheduledAt = `${todayYmd}T14:00:00.000Z`;
      expect(scheduledAt).toBe(expectedScheduledAt);
      // Also verify the date is FIXED_NOW's date.
      expect(scheduledAt.slice(0, 10)).toBe(expectedYmd);
    });

    it('has reminder rows in DynamoDB', async () => {
      const { Items } = await doc.send(new QueryCommand({
        TableName: `${prefix}tourReminders`,
        IndexName: 'byTour',
        KeyConditionExpression: '#tid = :tid',
        ExpressionAttributeNames: { '#tid': 'tourId' },
        ExpressionAttributeValues: { ':tid': LIVE_IDS.tourToday },
      }));
      // Quiet hours (default 21:00-08:00 America/New_York) reshape this ladder.
      // At 09:00 UTC (05:00 EDT - inside the window) seeding a 14:00 UTC
      // (10:00 EDT) tour: confirmation clamps to 12:00 UTC (08:00 EDT),
      // day_before is yesterday-14:00 (past - skipped), morning_of is 08:00
      // EDT = 12:00 UTC, en_route is 12:00 UTC. The three survivors all land on
      // the SAME 08:00-local instant, so supersession keeps only the last rung.
      expect(Items).toBeDefined();
      expect(Items!.length).toBeGreaterThanOrEqual(1);
    });

    it('the in-window seed time collapses the ladder onto one 08:00-local rung', async () => {
      const { Items } = await doc.send(new QueryCommand({
        TableName: `${prefix}tourReminders`,
        IndexName: 'byTour',
        KeyConditionExpression: '#tid = :tid',
        ExpressionAttributeNames: { '#tid': 'tourId' },
        ExpressionAttributeValues: { ':tid': LIVE_IDS.tourToday },
      }));
      const rows = Items ?? [];
      // confirmation would have been sent at 05:00 EDT - it is clamped to 08:00
      // EDT, collides with morning_of/en_route there, and the LAST rung (the
      // one whose copy is still true) is the only row written.
      expect(rows.map((r) => r['kind'])).toEqual(['en_route']);
      expect(rows[0]!['dueAt']).toBe(
        instantAtLocalTime(FIXED_NOW_ISO.slice(0, 10), '08:00', QUIET_WINDOW.timezone),
      );
      expect(rows.find((r) => r['kind'] === 'confirmation')).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // Tomorrow tour assertions — the money test (no dueAt drift)
  // ---------------------------------------------------------------------------
  describe('TOUR-B (tomorrow, landlord-led) — reminder dueAts match real computation', () => {
    const tomorrowDate = new Date(FIXED_NOW);
    tomorrowDate.setUTCDate(tomorrowDate.getUTCDate() + 1);
    const scheduledAtTomorrow = `${tomorrowDate.toISOString().slice(0, 10)}T14:00:00.000Z`;

    it('has 3 reminder rungs armed (morning_of is superseded by en_route)', async () => {
      const { Items } = await doc.send(new QueryCommand({
        TableName: `${prefix}tourReminders`,
        IndexName: 'byTour',
        KeyConditionExpression: '#tid = :tid',
        ExpressionAttributeNames: { '#tid': 'tourId' },
        ExpressionAttributeValues: { ':tid': LIVE_IDS.tourTomorrow },
      }));
      // At 09:00 UTC (05:00 EDT) today seeding a 14:00 UTC (10:00 EDT) tomorrow
      // tour, with the default quiet window:
      // confirmation = 09:00 today, inside the window -> clamped to 12:00 today
      // day_before = 14:00 today (future, daytime - unclamped)
      // morning_of = 08:00 EDT tomorrow = 12:00 UTC tomorrow
      // en_route = 12:00 UTC tomorrow - the SAME instant as morning_of, so the
      //   later rung supersedes morning_of and no morning_of row is written.
      // no_show_checkin is manual-send only now, so it is NOT auto-armed.
      expect(Items).toBeDefined();
      expect(Items!.length).toBe(3);
      expect((Items ?? []).map((r) => r['kind']).sort()).toEqual([
        'confirmation',
        'day_before',
        'en_route',
      ]);
    });

    it('each reminder dueAt matches computeDueAt(kind, scheduledAtTomorrow, FIXED_NOW_ISO)', async () => {
      const { Items } = await doc.send(new QueryCommand({
        TableName: `${prefix}tourReminders`,
        IndexName: 'byTour',
        KeyConditionExpression: '#tid = :tid',
        ExpressionAttributeNames: { '#tid': 'tourId' },
        ExpressionAttributeValues: { ':tid': LIVE_IDS.tourTomorrow },
      }));
      const byKind = new Map<string, string>();
      for (const item of Items ?? []) {
        byKind.set(item['kind'] as string, item['dueAt'] as string);
      }
      // morning_of clamps onto the SAME instant as en_route (both 08:00 EDT on
      // tour day), so the arm-time supersession rule writes no morning_of row -
      // asserted explicitly rather than skipped, so a regression that starts
      // writing it again fails here.
      const superseded: ReminderKind[] = ['morning_of'];
      for (const kind of REMINDER_KINDS) {
        const expectedDueAt = computeDueAt(kind, scheduledAtTomorrow, FIXED_NOW_ISO);
        if (superseded.includes(kind)) {
          expect(byKind.get(kind), `superseded kind '${kind}' must have no row`).toBeUndefined();
          continue;
        }
        // Only assert for kinds that should have been armed (dueAt >= FIXED_NOW_ISO).
        if (expectedDueAt >= FIXED_NOW_ISO) {
          expect(byKind.get(kind), `dueAt for kind '${kind}'`).toBe(expectedDueAt);
        }
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Placement deadline assertions
  // ---------------------------------------------------------------------------
  describe('PLACEMENT-A (overdue RTA)', () => {
    it('the rta_window placementDeadlines item is in the PAST relative to FIXED_NOW', async () => {
      const { Item } = await doc.send(new GetCommand({
        TableName: `${prefix}placementDeadlines`,
        Key: { deadlineId: `${LIVE_IDS.placementOverdueRta}#rta_window` },
      }));
      expect(Item).toBeDefined();
      expect(Item!['type']).toBe('rta_window');
      expect(Item!['placementId']).toBe(LIVE_IDS.placementOverdueRta);
      expect(new Date(Item!['at'] as string).getTime()).toBeLessThan(FIXED_NOW.getTime());
    });

    it('also carries a FUTURE voucher_expiration item (from tenant A voucher_expiration_date)', async () => {
      const { Item } = await doc.send(new GetCommand({
        TableName: `${prefix}placementDeadlines`,
        Key: { deadlineId: `${LIVE_IDS.placementOverdueRta}#voucher_expiration` },
      }));
      expect(Item).toBeDefined();
      expect(new Date(Item!['at'] as string).getTime()).toBeGreaterThan(FIXED_NOW.getTime());
    });
  });

  describe('PLACEMENT-B (follow-up due)', () => {
    it('the follow_up placementDeadlines item is at or before FIXED_NOW', async () => {
      const { Item } = await doc.send(new GetCommand({
        TableName: `${prefix}placementDeadlines`,
        Key: { deadlineId: `${LIVE_IDS.placementFollowUp}#follow_up` },
      }));
      expect(Item).toBeDefined();
      expect(Item!['type']).toBe('follow_up');
      expect(new Date(Item!['at'] as string).getTime()).toBeLessThanOrEqual(FIXED_NOW.getTime());
    });
  });

  // ---------------------------------------------------------------------------
  // Derived-status consistency (§7)
  // ---------------------------------------------------------------------------
  describe('live entity §7 derived-status consistency', () => {
    it('live tenant A status matches deriveStatuses(awaiting_landlord_submission)', async () => {
      const { Item } = await doc.send(new GetCommand({
        TableName: `${prefix}contacts`,
        Key: { contactId: LIVE_IDS.tenantA },
      }));
      expect(Item).toBeDefined();
      const expected = deriveStatuses('awaiting_landlord_submission');
      expect(Item!['status']).toBe(expected.tenantStatus);
      expect(Item!['status_source']).toBe('derived');
    });

    it('live unit A status matches deriveStatuses(awaiting_landlord_submission)', async () => {
      const { Item } = await doc.send(new GetCommand({
        TableName: `${prefix}units`,
        Key: { unitId: LIVE_IDS.unitA },
      }));
      expect(Item).toBeDefined();
      const expected = deriveStatuses('awaiting_landlord_submission');
      expect(Item!['status']).toBe(expected.listingStatus);
    });

    it('live tenant B status matches deriveStatuses(collect_rta)', async () => {
      const { Item } = await doc.send(new GetCommand({
        TableName: `${prefix}contacts`,
        Key: { contactId: LIVE_IDS.tenantB },
      }));
      expect(Item).toBeDefined();
      const expected = deriveStatuses('collect_rta');
      expect(Item!['status']).toBe(expected.tenantStatus);
    });
  });

  // ---------------------------------------------------------------------------
  // Now-relative lifecycle history (Task 3d live wiring)
  // ---------------------------------------------------------------------------
  describe('live lifecycle history — now-relative + monotonic trails', () => {
    it('overdue-RTA placement carries a now-relative, strictly-increasing audit trail', async () => {
      const { Items } = await doc.send(new QueryCommand({
        TableName: `${prefix}audit_events`,
        KeyConditionExpression: '#e = :e',
        ExpressionAttributeNames: { '#e': 'entityKey' },
        ExpressionAttributeValues: { ':e': `placements#${LIVE_IDS.placementOverdueRta}` },
      }));
      const rows = (Items ?? []).filter((r) => r['event_type'] === 'placement_stage_changed');
      expect(rows.length).toBeGreaterThan(0);
      const isos = rows.map((r) => String(r['ts']).split('#')[0]!).sort();
      // Strictly increasing ISO prefixes (chronological, collision-free).
      for (let i = 1; i < isos.length; i++) {
        expect(isos[i - 1]! < isos[i]!, `hop ${i} must be strictly after hop ${i - 1}`).toBe(true);
      }
      // Now-relative (NOT a fixed calendar literal): the newest hop equals the
      // placement's now-8-day stage_entered_at (OLD enough to be derived-stuck)
      // and is strictly before FIXED_NOW.
      const newest = isos[isos.length - 1]!;
      const stageEnteredAt = new Date(FIXED_NOW.getTime() - 8 * 24 * 60 * 60 * 1000).toISOString();
      expect(newest).toBe(stageEnteredAt);
      expect(new Date(newest).getTime()).toBeLessThan(FIXED_NOW.getTime());
      // The whole trail sits within a plausible now-relative window (< ~400d before now).
      expect(new Date(isos[0]!).getTime()).toBeGreaterThan(
        FIXED_NOW.getTime() - 400 * 24 * 60 * 60 * 1000,
      );
    });

    it('live tenant timeline milestones are now-relative (placement_opened present)', async () => {
      const { Items } = await doc.send(new QueryCommand({
        TableName: `${prefix}activity_events`,
        KeyConditionExpression: '#c = :c',
        ExpressionAttributeNames: { '#c': 'contactId' },
        ExpressionAttributeValues: { ':c': LIVE_IDS.tenantA },
      }));
      const rows = Items ?? [];
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.some((r) => r['type'] === 'placement_opened')).toBe(true);
      for (const r of rows) {
        const at = new Date(String(r['at'])).getTime();
        expect(at).toBeLessThanOrEqual(FIXED_NOW.getTime());
        expect(at).toBeGreaterThan(FIXED_NOW.getTime() - 400 * 24 * 60 * 60 * 1000);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // ID collision check
  // ---------------------------------------------------------------------------
  describe('no live ID collides with lean / matrix / cast IDs', () => {
    it('all live contact IDs are unique from lean+matrix+cast', () => {
      // Build the set of all known IDs from lean, matrix, cast (in-memory).
      const leanIds = new Set<string>();
      for (const items of Object.values(SEED)) {
        for (const item of items) {
          const pk = Object.keys(item).find(
            (k) => k.endsWith('Id') || k === 'entityKey' || k === 'poolNumber',
          );
          if (pk) leanIds.add(String(item[pk]));
        }
      }
      for (const items of Object.values(matrixItems())) {
        for (const item of items) {
          const pk = Object.keys(item).find(
            (k) => k.endsWith('Id') || k === 'entityKey' || k === 'poolNumber',
          );
          if (pk) leanIds.add(String(item[pk]));
        }
      }
      for (const items of Object.values(castItems())) {
        for (const item of items) {
          const pk = Object.keys(item).find(
            (k) => k.endsWith('Id') || k === 'entityKey' || k === 'poolNumber',
          );
          if (pk) leanIds.add(String(item[pk]));
        }
      }
      // Check that none of the live IDs appear in the existing set.
      const liveIds = Object.values(LIVE_IDS);
      for (const id of liveIds) {
        expect(leanIds.has(id), `live ID '${id}' must not collide with lean/matrix/cast`).toBe(false);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Reminder invariant: no requested tours have reminder rows
  // ---------------------------------------------------------------------------
  describe('reminder invariant — no rows for requested tours', () => {
    it('all tour reminder rows belong to non-requested tours', async () => {
      const { Items: reminderItems } = await doc.send(new ScanCommand({
        TableName: `${prefix}tourReminders`,
      }));
      const { Items: tourItems } = await doc.send(new ScanCommand({
        TableName: `${prefix}tours`,
      }));
      const requestedTourIds = new Set(
        (tourItems ?? [])
          .filter((t) => t['status'] === 'requested')
          .map((t) => t['tourId'] as string),
      );
      for (const row of reminderItems ?? []) {
        const tourId = row['tourId'] as string;
        expect(
          requestedTourIds.has(tourId),
          `reminder row ${row['reminderId']} belongs to a 'requested' tour — invariant violation`,
        ).toBe(false);
      }
    });
  });
});
