// The one-time retirement sweep (Phase B spec 4): the pure planner, and the
// mutating half against DynamoDB Local.
//
// The planner block needs no database. The integration block covers what the
// planner cannot see - scan paging, the tour cache, the CONDITIONAL write and
// idempotence - and those are exactly the halves an ops script must not ship
// untested, because the human runs it once against prod and never again.
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { PutCommand, ScanCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { tableName } from '../src/lib/config.js';
import { createDocumentClient, createDynamoClient } from '../src/lib/dynamo.js';
import { deleteTableIfExists, ensureTable } from '../src/lib/dynamoAdmin.js';
import { getTableSpec } from '../src/lib/tables.js';
import { createTourRemindersRepo } from '../src/repos/tourRemindersRepo.js';
import { createToursRepo } from '../src/repos/toursRepo.js';
import {
  planReminderRetirement,
  retirePausedTourReminders,
} from '../scripts/retire-paused-tour-reminders.js';

const NOW = '2026-08-31T12:00:00.000Z';
const PAST = '2026-08-30T15:00:00.000Z';
const FUTURE = '2026-09-05T15:00:00.000Z';
const pending = (kind: string, dueAt: string) => ({ kind, dueAt }) as never;

describe('planReminderRetirement', () => {
  it('population A: pre-tour pending rung on a past tour -> tour_already_passed', () => {
    expect(
      planReminderRetirement(pending('morning_of', '2026-08-30T11:00:00.000Z'), PAST, NOW),
    ).toBe('tour_already_passed');
  });

  it('population A uses the SHARED predicate: no_show_checkin on a past tour is NOT swept', () => {
    // Its dueAt FOLLOWS the tour, so retiredByTourStart exempts it by
    // construction - the sweep and the runtime gate cannot disagree here.
    expect(
      planReminderRetirement(pending('no_show_checkin', '2026-08-30T15:30:00.000Z'), PAST, NOW),
    ).toBe('skip');
  });

  it('population B: pending confirmation on a FUTURE tour -> kind_retired', () => {
    expect(
      planReminderRetirement(pending('confirmation', '2026-08-20T09:00:00.000Z'), FUTURE, NOW),
    ).toBe('kind_retired');
  });

  it('both populations: confirmation on a PAST tour takes population A token', () => {
    expect(
      planReminderRetirement(pending('confirmation', '2026-08-30T09:00:00.000Z'), PAST, NOW),
    ).toBe('tour_already_passed');
  });

  it('a pending non-confirmation rung on a future tour is untouched', () => {
    expect(
      planReminderRetirement(pending('day_before', '2026-09-04T23:30:00.000Z'), FUTURE, NOW),
    ).toBe('skip');
  });

  it('an absent scheduledAt never fires population A, but the kind rule still applies', () => {
    // invalid_schedule owns a row with no usable scheduledAt; the sweep must not
    // steal the more accurate token. A confirmation is still a retired KIND.
    expect(
      planReminderRetirement(pending('day_before', '2026-08-30T09:00:00.000Z'), undefined, NOW),
    ).toBe('skip');
    expect(
      planReminderRetirement(pending('confirmation', '2026-08-30T09:00:00.000Z'), undefined, NOW),
    ).toBe('kind_retired');
  });

  it('idempotent: sent, canceled, and already-skipped rows all skip', () => {
    for (const marker of [{ sentAt: NOW }, { canceledAt: NOW }, { skippedAt: NOW }]) {
      expect(
        planReminderRetirement({ kind: 'confirmation', dueAt: PAST, ...marker } as never, PAST, NOW),
      ).toBe('skip');
    }
  });

  it('operator-restored past-tour rung is swept too (spec 4.2 ruling)', () => {
    // restore clears canceledAt -> plain pending; nothing distinguishes it, by design.
    expect(planReminderRetirement(pending('en_route', '2026-08-30T14:00:00.000Z'), PAST, NOW)).toBe(
      'tour_already_passed',
    );
  });
});

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
    `[retirePausedTourReminders] SKIPPED - no DynamoDB Local at ${endpoint}. ` +
      'Run `npm run db:start` to exercise this suite.',
  );
}

describe.skipIf(!reachable)('retirePausedTourReminders against DynamoDB Local', () => {
  const client = createDynamoClient({ endpoint });
  const doc = createDocumentClient({ endpoint });
  const created: string[] = [];

  afterEach(async () => {
    // Each case owns its OWN table pair, so the `scanned` counts below are
    // counts of THAT case's world and cannot drift as cases are added.
    for (const table of created.splice(0)) await deleteTableIfExists(client, table);
  }, 120_000);

  /**
   * A freshly-tabled world holding ONE row per planner outcome, plus a row that
   * is already terminal:
   *
   *   pastMorningOf   - population A (pre-tour rung, tour already happened)
   *   pastNoShow      - EXEMPT: its dueAt follows the tour
   *   futureConfirm   - population B (discontinued kind, tour still ahead)
   *   futureDayBefore - untouched: a live kind on a tour that has not happened
   *   alreadySkipped  - terminal before the run; proves re-runs are no-ops
   */
  async function seedWorld() {
    const env = { TABLE_PREFIX: `hc-test-${randomUUID().slice(0, 8)}-` };
    const toursTable = tableName('tours', env);
    const remindersTable = tableName('tourReminders', env);
    await ensureTable(client, getTableSpec('tours'), toursTable);
    await ensureTable(client, getTableSpec('tourReminders'), remindersTable);
    created.push(remindersTable, toursTable);

    const tours = createToursRepo({ doc, env });
    const reminders = createTourRemindersRepo({ doc, env });
    const pastTour = await tours.create({
      tenantId: `tenant-${randomUUID().slice(0, 8)}`,
      unitId: 'unit-sweep-past',
      scheduledAt: PAST,
      tourType: 'self_guided',
    });
    const futureTour = await tours.create({
      tenantId: `tenant-${randomUUID().slice(0, 8)}`,
      unitId: 'unit-sweep-future',
      scheduledAt: FUTURE,
      tourType: 'self_guided',
    });
    const pastMorningOf = await reminders.create({
      tourId: pastTour.tourId,
      kind: 'morning_of',
      dueAt: '2026-08-30T11:00:00.000Z',
    });
    const pastNoShow = await reminders.create({
      tourId: pastTour.tourId,
      kind: 'no_show_checkin',
      dueAt: '2026-08-30T15:30:00.000Z',
    });
    const futureConfirm = await reminders.create({
      tourId: futureTour.tourId,
      kind: 'confirmation',
      dueAt: '2026-08-20T09:00:00.000Z',
    });
    const futureDayBefore = await reminders.create({
      tourId: futureTour.tourId,
      kind: 'day_before',
      dueAt: '2026-09-04T23:30:00.000Z',
    });
    const alreadySkipped = await reminders.create({
      tourId: pastTour.tourId,
      kind: 'en_route',
      dueAt: '2026-08-30T14:00:00.000Z',
      skipped: { at: '2026-08-30T14:00:01.000Z', reason: 'tenant_not_on_roster' },
    });

    const row = async (reminderId: string, tourId: string) =>
      (await reminders.listByTour(tourId)).find((r) => r.reminderId === reminderId);

    return {
      env,
      reminders,
      pastTour,
      futureTour,
      pastMorningOf,
      pastNoShow,
      futureConfirm,
      futureDayBefore,
      alreadySkipped,
      row,
    };
  }

  it('--dry-run reports the plan and writes NOTHING', async () => {
    const w = await seedWorld();

    const result = await retirePausedTourReminders({ dryRun: true, doc, env: w.env, now: NOW });

    expect(result).toMatchObject({
      scanned: 5,
      tourAlreadyPassed: 1,
      kindRetired: 1,
      skipped: 3,
      skippedOnCondition: { tour_already_passed: 0, kind_retired: 0 },
    });
    // Not one row moved.
    expect((await w.row(w.pastMorningOf.reminderId, w.pastTour.tourId))?.skippedAt).toBeUndefined();
    expect(
      (await w.row(w.futureConfirm.reminderId, w.futureTour.tourId))?.skippedAt,
    ).toBeUndefined();
  }, 120_000);

  it('a real run stamps exactly the planned rows with the planned tokens, and a SECOND run is a no-op', async () => {
    const w = await seedWorld();

    const first = await retirePausedTourReminders({ doc, env: w.env, now: NOW });

    expect(first).toMatchObject({
      scanned: 5,
      tourAlreadyPassed: 1,
      kindRetired: 1,
      skipped: 3,
      skippedOnCondition: { tour_already_passed: 0, kind_retired: 0 },
    });

    const swept = await w.row(w.pastMorningOf.reminderId, w.pastTour.tourId);
    expect(swept?.skippedAt).toBe(NOW);
    expect(swept?.skipReason).toBe('tour_already_passed');

    const retired = await w.row(w.futureConfirm.reminderId, w.futureTour.tourId);
    expect(retired?.skippedAt).toBe(NOW);
    expect(retired?.skipReason).toBe('kind_retired');

    // The exempt rung and the live future rung are untouched.
    expect((await w.row(w.pastNoShow.reminderId, w.pastTour.tourId))?.skippedAt).toBeUndefined();
    expect(
      (await w.row(w.futureDayBefore.reminderId, w.futureTour.tourId))?.skippedAt,
    ).toBeUndefined();
    // The already-terminal row keeps its ORIGINAL reason - never re-stamped.
    expect((await w.row(w.alreadySkipped.reminderId, w.pastTour.tourId))?.skipReason).toBe(
      'tenant_not_on_roster',
    );

    // Re-running after the deploy is safe and expected (RUNBOOK): everything is
    // terminal now, so the second pass writes nothing at all.
    const second = await retirePausedTourReminders({
      doc,
      env: w.env,
      now: '2026-08-31T13:00:00.000Z',
    });
    expect(second).toMatchObject({
      scanned: 5,
      tourAlreadyPassed: 0,
      kindRetired: 0,
      skipped: 5,
      skippedOnCondition: { tour_already_passed: 0, kind_retired: 0 },
    });
    expect((await w.row(w.pastMorningOf.reminderId, w.pastTour.tourId))?.skippedAt).toBe(NOW);
  }, 120_000);

  it('a rung the runtime SENDS mid-scan loses the conditional write and is reported, not swallowed', async () => {
    const w = await seedWorld();
    // The real race, driven through the injectable client rather than a
    // production seam: the sweep's Scan returns the plan, and the runtime claims
    // one of the planned rows before the sweep's write reaches it.
    let raced = false;
    const racingDoc = {
      send: async (command: unknown) => {
        const out = await (doc as DynamoDBDocumentClient).send(command as never);
        if (command instanceof ScanCommand && !raced) {
          raced = true;
          await w.reminders.claimSend(w.futureConfirm.reminderId, '2026-08-31T11:59:00.000Z');
        }
        return out;
      },
    } as unknown as DynamoDBDocumentClient;

    const result = await retirePausedTourReminders({ doc: racingDoc, env: w.env, now: NOW });

    expect(raced).toBe(true);
    expect(result.skippedOnCondition.kind_retired).toBe(1);
    expect(result.kindRetired).toBe(0);
    // The row keeps the runtime's outcome; the sweep did not overwrite it.
    const row = await w.row(w.futureConfirm.reminderId, w.futureTour.tourId);
    expect(row?.sentAt).toBe('2026-08-31T11:59:00.000Z');
    expect(row?.skippedAt).toBeUndefined();
    // The other planned row still landed - one lost race does not abort the run.
    expect((await w.row(w.pastMorningOf.reminderId, w.pastTour.tourId))?.skipReason).toBe(
      'tour_already_passed',
    );
  }, 120_000);

  it('one CORRUPT row is counted `failed` and does not abort the rest of the run', async () => {
    // Review round 1, B-S5. There is deliberately no FilterExpression, so EVERY
    // row in the table reaches tourFor(). A row with no tourId marshals to an
    // EMPTY Key (the client is removeUndefinedValues) and DynamoDB answers
    // ValidationException - which used to escape the paging loop and kill the
    // whole sweep, discarding every counter with it on the one run that matters.
    const w = await seedWorld();
    await doc.send(
      new PutCommand({
        TableName: tableName('tourReminders', w.env),
        Item: {
          reminderId: `rem-corrupt-${randomUUID().slice(0, 8)}`,
          kind: 'day_before',
          dueAt: '2026-08-30T11:00:00.000Z',
        },
      }),
    );

    const result = await retirePausedTourReminders({ doc, env: w.env, now: NOW });

    expect(result.failed).toBe(1);
    expect(result.scanned).toBe(6);
    // Every healthy row still got the outcome it planned.
    expect(result).toMatchObject({ tourAlreadyPassed: 1, kindRetired: 1, skipped: 3 });
    expect((await w.row(w.pastMorningOf.reminderId, w.pastTour.tourId))?.skipReason).toBe(
      'tour_already_passed',
    );
    expect((await w.row(w.futureConfirm.reminderId, w.futureTour.tourId))?.skipReason).toBe(
      'kind_retired',
    );
  }, 120_000);

  it('pages the Scan, and reads each tour ONCE however many rungs it owns', async () => {
    const w = await seedWorld();
    // 60 extra pending confirmations on the FUTURE tour (population B), forced
    // across more than one Scan page so a paging bug cannot hide behind a
    // single-page table.
    for (let i = 0; i < 60; i += 1) {
      await w.reminders.create({
        tourId: w.futureTour.tourId,
        kind: 'confirmation',
        dueAt: '2026-08-20T09:00:00.000Z',
      });
    }

    const result = await retirePausedTourReminders({
      dryRun: true,
      doc,
      env: w.env,
      now: NOW,
      scanLimit: 7,
    });

    expect(result.scanned).toBe(65);
    expect(result.kindRetired).toBe(61);
    expect(result.tourAlreadyPassed).toBe(1);
    // The tour cache: 65 rows across TWO tours is two reads, not 65.
    expect(result.toursRead).toBe(2);
  }, 120_000);
});
