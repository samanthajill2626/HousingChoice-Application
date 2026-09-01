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
// FAILURE HANDLING, in one place. A row the sweep cannot PLAN (a malformed row)
// is stepped over and counted `failed` - one bad row must not kill the run - but
// a completed run with `failed > 0` still reports at WARN and exits 1, because
// stepping over rows is not a clean pass. A WRITE failure is different in kind:
// it is systemic until proven otherwise, so it ABORTS, and the run logs a
// PARTIAL report (the counters as of the abort) before the error and exits 1.
// The one write error that does NOT abort is the conditional check, which means
// the runtime beat us to the row and its outcome is the right one.
//
// PII: logs COUNTS, tourIds and reminderIds only. Never a name, phone or body.
//
// Run (from repo root, tsx): `tsx app/scripts/retire-paused-tour-reminders.ts`
//   --dry-run   scan + report the plan (counts only); write NOTHING.
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { ScanCommand, UpdateCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { DISCONTINUED_REMINDER_KINDS, retiredByTourStart } from '../src/jobs/tourReminders.js';
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
  // Population B reads the SHARED SET, never a kind literal - the same rule that
  // put population A on retiredByTourStart. DISCONTINUED_REMINDER_KINDS is what
  // stops a kind sending at every runtime surface, and this sweep is the ONE
  // writer of `kind_retired`; a literal here means that discontinuing a second
  // kind would leave its rows pending forever while every surface refused them,
  // which is exactly the panel-hygiene hole population B exists to close.
  if (DISCONTINUED_REMINDER_KINDS.has(row.kind)) return 'kind_retired';
  return 'skip';
}

export interface ReminderRetirementResult {
  scanned: number;
  tourAlreadyPassed: number;
  kindRetired: number;
  skipped: number;
  /** Writes whose condition failed because the row moved under the run. */
  skippedOnCondition: { tour_already_passed: number; kind_retired: number };
  /** Rows the sweep could not PLAN (the tour read threw, a blank/absent tourId)
   *  and stepped over. Nothing was written for them, so this is a re-run list,
   *  not data loss - but a non-zero value makes the run exit 1
   *  (reportRetirementRun). A WRITE failure never lands here: it aborts. */
  failed: number;
  /** Distinct tours read (the cache's saving is scanned - toursRead). */
  toursRead: number;
}

export type RetirePausedTourRemindersOpts = {
    dryRun?: boolean;
    doc?: DynamoDBDocumentClient;
    env?: NodeJS.ProcessEnv;
    /** The instant population A is judged against. Defaults to the wall clock. */
    now?: string;
    /** Bound the Scan page size. An ops knob for a large table (and what makes
     *  the paging loop exercisable); unset means the service default. */
    scanLimit?: number;
};

/**
 * The sweep. Wraps the scan/retire loop so an ABORT still reports what landed:
 * the counters accumulate into a value this function owns, and the catch logs
 * them as a PARTIAL report before re-throwing (the same shape
 * backfill-media-content-types.ts uses, and what the RUNBOOK promises). Without
 * it an operator whose prod run dies at row 400 of 900 learns neither how many
 * rows were stamped nor with which tokens - and the RUNBOOK's "read the report
 * before applying" and its skippedOnCondition promise both evaporate on the one
 * run where they matter. Every write is idempotent, so a re-run repairs the
 * data; the report is what tells the operator whether it needs to.
 */
export async function retirePausedTourReminders(
  opts: RetirePausedTourRemindersOpts = {},
): Promise<ReminderRetirementResult> {
  const result: ReminderRetirementResult = {
    scanned: 0,
    tourAlreadyPassed: 0,
    kindRetired: 0,
    skipped: 0,
    skippedOnCondition: { tour_already_passed: 0, kind_retired: 0 },
    failed: 0,
    toursRead: 0,
  };
  try {
    await scanAndRetire(opts, result);
  } catch (err) {
    // PII-identical to the success report: counts, tourIds and reminderIds only.
    logger.error(
      { ...result, dryRun: opts.dryRun === true },
      'retire-paused-tour-reminders - PARTIAL result: the run ABORTED and these counters cover only what completed before the failure. Every write is idempotent, so re-running after the fix is safe - see the error below.',
    );
    throw err;
  }
  return result;
}

/** The scan/retire loop. Accumulates into the CALLER's `result` so a throw does
 *  not take the counters with it (see the wrapper above). */
async function scanAndRetire(
  opts: RetirePausedTourRemindersOpts,
  result: ReminderRetirementResult,
): Promise<void> {
  const doc = opts.doc ?? getDocumentClient();
  const env = opts.env ?? process.env;
  const table = tableName('tourReminders', env);
  const dryRun = opts.dryRun === true;
  const now = opts.now ?? new Date().toISOString();
  const toursRepo = createToursRepo({ doc, env });

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
      // TWO FAILURE CLASSES, OPPOSITE TREATMENT (round 2, R2-M1). The round-1
      // ruling said only "per-row try/catch, continue", which was implemented
      // literally and swallowed both - so a run whose every WRITE failed
      // reported `failed: <every row>`, logged "done" and exited 0.
      //
      //   PLAN side (below) - deciding what this row needs. There is no
      //   FilterExpression, so every row reaches tourFor() unvalidated, and a
      //   row with a missing or blank tourId marshals to an EMPTY Key (the
      //   client is removeUndefinedValues) which DynamoDB rejects. That is a
      //   fact about ONE row: a whole prod run dying on one malformed row is
      //   strictly worse than stepping over it. Counted `failed`, and nothing is
      //   written for it, so `failed` is a re-run list rather than data loss.
      let action: ReminderRetirementAction;
      try {
        const tour = await tourFor(raw.tourId);
        action = planReminderRetirement(raw, tour?.scheduledAt, now);
      } catch (err) {
        result.failed += 1;
        // PII: the two ids and the error. Never a name, phone or body.
        logger.error(
          { err, reminderId: raw.reminderId, tourId: raw.tourId },
          'retire-paused-tour-reminders - row could not be PLANNED; stepped over and counted `failed`',
        );
        continue;
      }
      if (action === 'skip') {
        result.skipped += 1;
        continue;
      }
      if (dryRun) {
        if (action === 'tour_already_passed') result.tourAlreadyPassed += 1;
        else result.kindRetired += 1;
        continue;
      }
      //   WRITE side - a failure here is SYSTEMIC until proven otherwise
      //   (rotated credentials, a missing dynamodb:UpdateItem, a wrong
      //   TABLE_PREFIX, sustained throttling), and it is not a property of the
      //   row at all. So it ABORTS: the throw escapes the paging loop, the
      //   wrapper logs the PARTIAL counters and the process exits 1 - the
      //   behaviour of the sibling this script is modelled on (RUNBOOK :95).
      //   Continuing would convert "this run wrote nothing" into a report that
      //   reads like a clean pass.
      //
      //   The ONE exception is the conditional check, which is not a failure at
      //   all: it means the runtime sent/canceled/skipped the row between the
      //   plan and the write, and the runtime's outcome is the correct one.
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
}

/**
 * The end-of-run report, and the EXIT CODE it earns. Exported so the exit-code
 * rule is testable: `process.exitCode` lives in the CLI block below, which no
 * test can reach.
 *
 * A COMPLETE run that stepped over rows is not a clean run (round 2, R2-M1).
 * Stepping over a malformed row is what keeps the other rows repairable, but an
 * operator who reads only the exit code - or skims for an error line - must not
 * be told a run that could not decide 900 rows was a success. So `failed > 0`
 * reports at WARN and exits 1: investigate the logged reminderIds, then re-run
 * (every write is idempotent, so a re-run is always safe).
 *
 * Including on a DRY RUN, deliberately: the dry run is exactly where an
 * undecidable row should surface, before the apply rather than during it.
 */
export function reportRetirementRun(result: ReminderRetirementResult, dryRun: boolean): 0 | 1 {
  const suffix = dryRun ? ' (DRY RUN - nothing written)' : '';
  if (result.failed > 0) {
    logger.warn(
      { ...result, dryRun },
      `retire-paused-tour-reminders - COMPLETED WITH FAILURES${suffix}: ${result.failed} row(s) could not be planned and were stepped over (nothing was written for them). Investigate the logged reminderIds, then re-run - re-running is idempotent.`,
    );
    return 1;
  }
  logger.info({ ...result, dryRun }, `retire-paused-tour-reminders - done${suffix}`);
  return 0;
}

const invokedDirectly =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('retire-paused-tour-reminders.ts');
if (invokedDirectly) {
  const dryRun = process.argv.includes('--dry-run');
  logger.info({ dryRun }, 'retire-paused-tour-reminders - starting');
  retirePausedTourReminders({ dryRun })
    .then((result) => {
      process.exitCode = reportRetirementRun(result, dryRun);
    })
    .catch((err: unknown) => {
      // The PARTIAL counters were logged on the line ABOVE this one, by the
      // wrapper - read that before re-running.
      logger.error({ err }, 'retire-paused-tour-reminders - FAILED (see the PARTIAL report above)');
      process.exitCode = 1;
    });
}
