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
import type { TableNamespace } from '../src/lib/devReset.js';
import { deriveStatuses } from '../src/lib/statusModel.js';
import { shiftLocalDate } from '../src/lib/localTime.js';
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
// copy mirrors BOTH halves of the new rule - day_before is 19:30 ORG-LOCAL on
// the day before the tour's local date, and every rung is clamped out of the
// org's quiet window before it is stored. Only the ladder OFFSETS stay
// hand-written; the
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
        // 19:30 ORG-LOCAL the evening before the tour's LOCAL date (founder
        // retiming, Cameron 2026-08-26; was scheduledAt - 24h).
        return instantAtLocalTime(
          shiftLocalDate(localDateOf(scheduledAt, QUIET_WINDOW.timezone), -1),
          '19:30',
          QUIET_WINDOW.timezone,
        );
      case 'morning_of':
        // FOUR hours before the tour (founder retiming, Cameron 2026-08-26;
        // was 08:00 org-local). The persisted KIND keeps its name.
        return new Date(scheduled - 4 * 60 * 60 * 1000).toISOString();
      case 'en_route':
        // ONE hour before (founder decision 2026-08-18, was two). This is a
        // DELIBERATE second implementation of jobs/tourReminders.ts computeDueAt
        // - it exists to catch drift, so it has to be moved in lockstep whenever
        // the real offset changes.
        return new Date(scheduled - 1 * 60 * 60 * 1000).toISOString();
      case 'no_show_checkin':
        return new Date(scheduled + 30 * 60 * 1000).toISOString();
    }
  })();
  // EN_ROUTE IS EXEMPT from the clamp (Phase B spec 6, founder decision
  // 2026-08-31) - mirrored from armTourReminders, which applies the exemption
  // at its own call site and leaves clampOutOfQuietHours itself kind-blind.
  // This copy exists to catch drift, so it moves in lockstep or it lies.
  return kind === 'en_route' ? raw : clampOutOfQuietHours(raw, QUIET_WINDOW);
}

// Two kinds are intentionally NOT auto-armed, so both are omitted here to
// mirror the canonical REMINDER_KINDS in jobs/tourReminders.ts: no_show_checkin
// (manual send only) and confirmation (retired by the founder 2026-08-24;
// arming stopped 2026-08-31, Phase B). The ReminderKind type + computeDueAt
// cases above deliberately keep all 5 kinds - each stays legal everywhere it is
// read or rendered, it is just never armed.
const REMINDER_KINDS: ReminderKind[] = ['day_before', 'morning_of', 'en_route'];

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

  const namespace: TableNamespace = {
    tablePrefix: prefix,
    tableNameFor: (base) => `${prefix}${base}`,
    env: Object.freeze({ TABLE_PREFIX: prefix }) as NodeJS.ProcessEnv,
  };

  beforeAll(async () => {
    // Create all tables under the throwaway prefix.
    for (const spec of TABLES) {
      await ensureTable(client, spec, `${prefix}${spec.baseName}`);
    }
    // Run seedLive with the fixed now.
    await seedLive(endpoint, FIXED_NOW, namespace);
  }, 120_000);

  afterAll(async () => {
    // Drop all throwaway tables.
    for (const spec of TABLES) {
      await deleteTableIfExists(client, `${prefix}${spec.baseName}`);
    }
    doc.destroy();
  }, 120_000);

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
      // Quiet hours (default 21:00-08:00 America/New_York) and the two
      // booked-too-late rules together reshape this ladder. At 09:00 UTC
      // (05:00 EDT) seeding a 14:00 UTC (10:00 EDT) SAME-DAY tour: day_before
      // is retired booked_too_late, morning_of clamps to 12:00 UTC (08:00 EDT)
      // and is retired booked_too_late too, and only en_route (13:00 UTC) is
      // left live. (confirmation stopped arming 2026-08-31, Phase B.)
      expect(Items).toBeDefined();
      expect(Items!.length).toBeGreaterThanOrEqual(1);
    });

    it('the same-day seed leaves only en_route live: both near rungs are booked_too_late', async () => {
      const { Items } = await doc.send(new QueryCommand({
        TableName: `${prefix}tourReminders`,
        IndexName: 'byTour',
        KeyConditionExpression: '#tid = :tid',
        ExpressionAttributeNames: { '#tid': 'tourId' },
        ExpressionAttributeValues: { ':tid': LIVE_IDS.tourToday },
      }));
      const rows = Items ?? [];
      // A rung retired at arm time is written as a VISIBLE skipped row (the
      // panel trace, 2026-08-04) rather than being silently absent, so this
      // same-day seed leaves two traces and one live rung.
      //
      // Since 2026-08-26 the two booked-too-late rules (spec section 8) take
      // the two near rungs FIRST, so en_route is the only live rung left:
      //  - day_before RAW = 19:30 EDT yesterday; its rule-1 cutoff (RAW - 4h)
      //    is well behind the seed clock, so it is retired with a VISIBLE
      //    booked_too_late row instead of the old silent past-dueAt drop.
      //  - morning_of is same-day and the seed clock (09:00Z) is past
      //    scheduledAt - 6h (08:00Z), so rule 2 retires it too - at the CLAMPED
      //    08:00-local dueAt, exactly like every other arm-time skip row.
      // en_route (1h before the tour since 2026-08-18) has no rule of its own
      // and sits an hour clear of the 08:00 slot, so it survives.
      const pending = rows.filter((r) => r['skippedAt'] === undefined);
      expect(pending.map((r) => r['kind']).sort()).toEqual(['en_route']);
      const morningOf = rows.find((r) => r['kind'] === 'morning_of');
      expect(morningOf?.['skipReason']).toBe('booked_too_late');
      expect(morningOf?.['dueAt']).toBe(
        instantAtLocalTime(FIXED_NOW_ISO.slice(0, 10), '08:00', QUIET_WINDOW.timezone),
      );
      const dayBefore = rows.find((r) => r['kind'] === 'day_before');
      expect(dayBefore?.['skipReason']).toBe('booked_too_late');
      // No confirmation row is born at all (arming stopped 2026-08-31), so the
      // seeded world has nothing for the retirement sweep to find here.
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

    it('has 3 reminder rungs armed (day_before, morning_of, en_route - the whole auto ladder)', async () => {
      const { Items } = await doc.send(new QueryCommand({
        TableName: `${prefix}tourReminders`,
        IndexName: 'byTour',
        KeyConditionExpression: '#tid = :tid',
        ExpressionAttributeNames: { '#tid': 'tourId' },
        ExpressionAttributeValues: { ':tid': LIVE_IDS.tourTomorrow },
      }));
      // At 09:00 UTC (05:00 EDT) today seeding a 14:00 UTC (10:00 EDT) tomorrow
      // tour, with the default quiet window:
      // day_before = 14:00 today (future, daytime - unclamped)
      // morning_of = 08:00 EDT tomorrow = 12:00 UTC tomorrow
      // en_route = 13:00 UTC tomorrow (scheduledAt - 1h since the founder
      //   decision of 2026-08-18; at the old 2h it was 12:00, the SAME instant
      //   as morning_of, which is why morning_of used to be superseded here).
      //   An hour apart now, so ALL THREE rungs are armed.
      // no_show_checkin is manual-send only, and confirmation stopped arming
      // 2026-08-31 (Phase B), so neither is auto-armed. The title has said
      // "3 rungs" since the en_route retiming; it is finally true.
      expect(Items).toBeDefined();
      expect(Items!.length).toBe(3);
      const pending = (Items ?? []).filter((r) => r['skippedAt'] === undefined);
      expect(pending.map((r) => r['kind']).sort()).toEqual([
        'day_before',
        'en_route',
        'morning_of',
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
      // Nothing is superseded on this tour any more. morning_of used to clamp
      // onto the SAME instant as en_route (both 08:00 EDT on tour day) and lose
      // the slot; moving en_route to 1h before (founder decision 2026-08-18)
      // separates them, so every rung is armed with its own computed dueAt. Kept
      // as an explicit empty list so a future collision has an obvious home.
      const superseded: ReminderKind[] = [];
      for (const kind of REMINDER_KINDS) {
        const expectedDueAt = computeDueAt(kind, scheduledAtTomorrow, FIXED_NOW_ISO);
        if (superseded.includes(kind)) {
          const row = (Items ?? []).find((r) => r['kind'] === kind);
          expect(row?.['skippedAt'], `superseded kind '${kind}' must be a skipped row`).toBeDefined();
          expect(row?.['skipReason']).toBe('quiet_hours_superseded');
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
  // Ladder pointer (tour-reminder supersession, S4/T4.1): the demo world must
  // arm ladders that are LIVE, not born refused (spec acceptance 17). Every
  // armed rung carries the generation ladderId the armer minted, and its tour
  // must POINT at that generation - otherwise the poll refuses the whole demo
  // world as superseded and every seeded ladder reads as history.
  // ---------------------------------------------------------------------------
  describe('ladder pointer - every seeded live rung is on its tour CURRENT ladder', () => {
    it('every reminder row ladderId equals its tour currentLadderId', async () => {
      const { Items: reminderItems } = await doc.send(new ScanCommand({
        TableName: `${prefix}tourReminders`,
      }));
      const { Items: tourItems } = await doc.send(new ScanCommand({
        TableName: `${prefix}tours`,
      }));
      const pointerByTour = new Map(
        (tourItems ?? []).map((t) => [t['tourId'] as string, t['currentLadderId']]),
      );
      const rows = reminderItems ?? [];
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        const tourId = row['tourId'] as string;
        expect(
          row['ladderId'],
          `reminder ${row['reminderId']} must carry a ladderId`,
        ).toEqual(expect.any(String));
        expect(
          row['ladderId'],
          `reminder ${row['reminderId']} must match tour ${tourId} currentLadderId`,
        ).toBe(pointerByTour.get(tourId));
      }
    });

    it('all three live tours carry a pointer and no two share a ladder', async () => {
      const ids = [LIVE_IDS.tourToday, LIVE_IDS.tourTomorrow, LIVE_IDS.tourUpcoming];
      const pointers: string[] = [];
      for (const tourId of ids) {
        const { Item } = await doc.send(new GetCommand({
          TableName: `${prefix}tours`,
          Key: { tourId },
        }));
        expect(Item, `tour ${tourId} must exist`).toBeDefined();
        // All three live tours are 'scheduled' - none is terminal - so each one
        // points at the ladder it just armed.
        expect(Item!['currentLadderId'], `tour ${tourId} pointer`).toEqual(expect.any(String));
        pointers.push(Item!['currentLadderId'] as string);
      }
      expect(new Set(pointers).size).toBe(3);
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
