// retire-paused-tour-reminders - ONE-TIME, IDEMPOTENT sweep retiring the tour
// reminder rungs that were armed while the ladder was paused (2026-08-20 to
// 2026-08-31, Phase B spec section 4).
//
// A manual-only rung is left PENDING, not claim-skipped, so "Send now" keeps
// working - which means every rung armed during the pause is still sitting
// there, due, waiting. Lifting the pause without this sweep sends the lot on
// the next poll tick, carrying OLD dueAts: a burst of reminders for tours that
// are long past.
//
// TWO POPULATIONS, and a row in both takes A's token:
//
//   A. tour_already_passed - a PENDING rung whose OWN dueAt precedes a tour
//      whose scheduledAt is already past. The criterion is THE TOUR being past,
//      never the dueAt alone: a confirmation armed for next week's tour is
//      past-due from birth and is not population A. This uses the SHARED
//      predicate retiredByTourStart, the same one the fire-time gate in
//      jobs/tourReminders.ts applies - if the sweep and the runtime could
//      disagree about a row, one of them would be wrong. no_show_checkin is
//      exempt by construction (its dueAt follows the tour).
//
//   B. kind_retired - every pending `confirmation`, regardless of tour date.
//      The kind is discontinued, and REMINDER_KINDS governs ARMING only, so an
//      in-flight confirmation for a FUTURE tour survives the kind removal.
//      This arm is PANEL HYGIENE: DISCONTINUED_REMINDER_KINDS is what stops
//      those rows sending. Without the sweep they sit in the ladder forever
//      reading "no longer sent" against a tour that has not happened yet.
//
// Rows already sent/canceled/skipped are never touched, and every write is
// CONDITIONAL on exactly the state the planner decided from, so a concurrent
// runtime write cannot be double-applied and re-running is always safe.
//
// Targets DYNAMODB_ENDPOINT (default DynamoDB Local) and resolves the physical
// table via lib/config.tableName (respects TABLE_PREFIX) - the same posture as
// the backfill-*.ts scripts, deliberately: no local-only guard, this is an ops
// script the human runs against dev and prod per the RUNBOOK with the target
// environment set on purpose. NO AGENT RUNS THIS AGAINST A REAL ENVIRONMENT;
// an agent may run it only against a hermetic local lane.
//
// PII: logs COUNTS, tourIds and reminderIds only. Never a name, phone or body.
//
// Run (from repo root, tsx): `tsx app/scripts/retire-paused-tour-reminders.ts`
//   --dry-run   scan + report the plan (counts only); write NOTHING.
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { ScanCommand, UpdateCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { retiredByTourStart } from '../src/jobs/tourReminders.js';
import { tableName } from '../src/lib/config.js';
import { getDocumentClient } from '../src/lib/dynamo.js';
import { logger } from '../src/lib/logger.js';
import type { TourReminderItem } from '../src/repos/tourRemindersRepo.js';
import { createToursRepo } from '../src/repos/toursRepo.js';
import type { TourItem } from '../src/repos/toursRepo.js';

export type ReminderRetirementAction = 'tour_already_passed' | 'kind_retired' | 'skip';

/**
 * What one row needs. PURE, so it is unit-testable without DynamoDB.
 *
 * Terminal rows are checked FIRST - that is what makes a re-run a no-op rather
 * than a re-stamp that would overwrite an honest earlier reason. Population A
 * is checked before population B because a row in both takes A's token: "the
 * tour had already happened" is the more specific truth, and "no longer sent"
 * on a tour next Tuesday would be a visible falsehood on the panel.
 */
export function planReminderRetirement(
  row: Pick<TourReminderItem, 'kind' | 'dueAt' | 'sentAt' | 'canceledAt' | 'skippedAt'>,
  scheduledAt: string | undefined,
  now: string,
): ReminderRetirementAction {
  if (row.sentAt !== undefined || row.canceledAt !== undefined || row.skippedAt !== undefined) {
    return 'skip'; // terminal rows are never touched - what makes re-runs safe
  }
  if (retiredByTourStart(row, scheduledAt, now)) return 'tour_already_passed';
  if (row.kind === 'confirmation') return 'kind_retired';
  return 'skip';
}

export interface ReminderRetirementResult {
  scanned: number;
  tourAlreadyPassed: number;
  kindRetired: number;
  skipped: number;
  /** Writes whose condition failed because the row moved under the run. */
  skippedOnCondition: { tour_already_passed: number; kind_retired: number };
  /** Distinct tours read (the cache's saving is scanned - toursRead). */
  toursRead: number;
}

export async function retirePausedTourReminders(
  opts: {
    dryRun?: boolean;
    doc?: DynamoDBDocumentClient;
    env?: NodeJS.ProcessEnv;
    /** The instant population A is judged against. Defaults to the wall clock. */
    now?: string;
    /** Bound the Scan page size. An ops knob for a large table (and what makes
     *  the paging loop exercisable); unset means the service default. */
    scanLimit?: number;
  } = {},
): Promise<ReminderRetirementResult> {
  const doc = opts.doc ?? getDocumentClient();
  const env = opts.env ?? process.env;
  const table = tableName('tourReminders', env);
  const dryRun = opts.dryRun === true;
  const now = opts.now ?? new Date().toISOString();
  const toursRepo = createToursRepo({ doc, env });
  const result: ReminderRetirementResult = {
    scanned: 0,
    tourAlreadyPassed: 0,
    kindRetired: 0,
    skipped: 0,
    skippedOnCondition: { tour_already_passed: 0, kind_retired: 0 },
    toursRead: 0,
  };

  // A whole ladder shares one tourId, so without this cache the sweep would
  // re-read the same tour up to four times per tour. `undefined` is CACHED
  // too - a missing tour is a stable answer, not a retry.
  const tourCache = new Map<string, TourItem | undefined>();
  const tourFor = async (tourId: string): Promise<TourItem | undefined> => {
    if (tourCache.has(tourId)) return tourCache.get(tourId);
    const tour = await toursRepo.get(tourId);
    tourCache.set(tourId, tour);
    result.toursRead += 1;
    return tour;
  };

  /**
   * Stamp the row terminal under exactly the condition the planner decided
   * from. A rung the runtime sent, canceled or skipped between the plan and
   * this write LOSES here, and the loss is reported rather than swallowed.
   */
  const retire = async (reminderId: string, reason: ReminderRetirementAction): Promise<void> => {
    await doc.send(
      new UpdateCommand({
        TableName: table,
        Key: { reminderId },
        UpdateExpression: 'SET #skippedAt = :skippedAt, #skipReason = :reason',
        ConditionExpression:
          'attribute_exists(reminderId) AND attribute_not_exists(#sentAt) AND ' +
          'attribute_not_exists(#canceledAt) AND attribute_not_exists(#skippedAt)',
        ExpressionAttributeNames: {
          '#sentAt': 'sentAt',
          '#canceledAt': 'canceledAt',
          '#skippedAt': 'skippedAt',
          '#skipReason': 'skipReason',
        },
        ExpressionAttributeValues: { ':skippedAt': now, ':reason': reason },
      }),
    );
  };

  // NO server-side FilterExpression, deliberately: the reminder table is small,
  // and scanning every row is what keeps the planner's terminal-row rule a LIVE
  // rule rather than one only its unit test ever exercises - and what makes
  // `scanned` an honest count of the table rather than of a filter.
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const page = await doc.send(
      new ScanCommand({
        TableName: table,
        ...(opts.scanLimit !== undefined && { Limit: opts.scanLimit }),
        ...(exclusiveStartKey !== undefined && { ExclusiveStartKey: exclusiveStartKey }),
      }),
    );
    for (const raw of (page.Items ?? []) as TourReminderItem[]) {
      result.scanned += 1;
      const tour = await tourFor(raw.tourId);
      const action = planReminderRetirement(raw, tour?.scheduledAt, now);
      if (action === 'skip') {
        result.skipped += 1;
        continue;
      }
      if (dryRun) {
        if (action === 'tour_already_passed') result.tourAlreadyPassed += 1;
        else result.kindRetired += 1;
        continue;
      }
      try {
        await retire(raw.reminderId, action);
        if (action === 'tour_already_passed') result.tourAlreadyPassed += 1;
        else result.kindRetired += 1;
      } catch (err) {
        if (!(err instanceof ConditionalCheckFailedException)) throw err;
        result.skippedOnCondition[action] += 1;
        logger.info(
          { reminderId: raw.reminderId, tourId: raw.tourId, action },
          'retire-paused-tour-reminders - row moved under the run; skipped',
        );
      }
    }
    exclusiveStartKey = page.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (exclusiveStartKey !== undefined);

  return result;
}

const invokedDirectly =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('retire-paused-tour-reminders.ts');
if (invokedDirectly) {
  const dryRun = process.argv.includes('--dry-run');
  logger.info({ dryRun }, 'retire-paused-tour-reminders - starting');
  retirePausedTourReminders({ dryRun })
    .then((result) => {
      logger.info(
        { ...result, dryRun },
        `retire-paused-tour-reminders - done${dryRun ? ' (DRY RUN - nothing written)' : ''}`,
      );
    })
    .catch((err: unknown) => {
      logger.error({ err }, 'retire-paused-tour-reminders - FAILED');
      process.exitCode = 1;
    });
}
