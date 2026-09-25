// enable-conversation-automation - ONE-TIME, IDEMPOTENT: switch one-to-one
// conversations from `ai_mode = manual` back to `auto` (share-skip-fix spec D2).
//
// WHY. The Quo import created every conversation `manual`, and the one-to-one
// send wrapper refuses EVERY automated text on a manual conversation - staff
// property sends (until Branch A), tour reminders, the missed-call text, the
// welcome text and the 30003 retry. Nothing else ever turns the switch back on:
// there is no UI or API, and the breaker only turns it off.
//
// POPULATION (bulk mode): rows whose `ai_mode` is exactly `manual` and whose
// type is NOT relay_group / group_text - the codebase's own one-to-one
// definition (lib/unreadFeed.ts isOneToOneBucket), which includes legacy rows
// with no type. Pointer items (phone#/email#/token#) carry no ai_mode and are
// never matched. A row with NO ai_mode is left alone (the wrapper already reads
// absent as auto). A row with a breaker trip on record (a `mode_changed` audit
// event with reason `breaker_trip`) is EXCLUDED unless --include-breaker-tripped
// is passed: Cameron reviews the census list first.
//
// SINGLE MODE (--conversation <id>): the breaker-resume path. Enables that one
// row; refuses an unknown id or a group thread as a USAGE error (exit 2, no
// partial-run banner); reports an already-on row.
//
// EVERY WRITE IS CONDITIONAL on the row still being a one-to-one conversation
// with the switch off, so a re-run and a concurrent runtime write are both
// safe: a lost condition is counted `skippedOnCondition`, never overwritten.
// Every enable appends a `mode_changed` audit event (manual -> auto) whose
// reason tells a bulk enable (`bulk_enable`) from a resume (`operator_resume`).
// The switch write and the audit write are two operations: if the audit write
// fails AFTER the switch landed, the row is on and a re-run would report it
// `alreadyOn`, so that case is NAMED at ERROR (conversationId + "audit NOT
// written"), counted `auditFailed`, and the run exits 1 - the operator
// backfills the event from the log line (spec I6: every change audited, and
// never silently not).
//
// FAILURE HANDLING mirrors retire-paused-tour-reminders.ts: a row that cannot
// be PLANNED is stepped over and counted `failed` (exit 1); a SWITCH write
// failure other than the conditional check ABORTS with a PARTIAL report.
//
// TARGET: `--env local|dev|prod` through scripts/lib/stageClient.ts (dev/prod:
// account guard first, client bound to the housingchoice profile). DRY RUN IS
// THE DEFAULT; `--apply` writes. An agent runs this ONLY with `--env local
// --lane <L>` against a hermetic e2e lane it started. NO AGENT RUNS THIS
// AGAINST A REAL ENVIRONMENT; the human does, dry run first, per the RUNBOOK.
//
//   npx tsx app/scripts/enable-conversation-automation.ts --env dev
//   npx tsx app/scripts/enable-conversation-automation.ts --env dev --apply
//   npx tsx app/scripts/enable-conversation-automation.ts --env dev --apply --conversation <id>
//   npx tsx app/scripts/enable-conversation-automation.ts --env dev --apply --include-breaker-tripped
//
// PII: logs counts and conversation ids only. Never a name, phone or body.
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { GetCommand, ScanCommand, UpdateCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { tableName } from '../src/lib/config.js';
import { logger as defaultLogger, type Logger } from '../src/lib/logger.js';
import { isOneToOneBucket } from '../src/lib/unreadFeed.js';
import { createAuditRepo } from '../src/repos/auditRepo.js';
import type { ConversationItem } from '../src/repos/conversationsRepo.js';
import { findBreakerTrip, isPointerRow } from './conversation-automation-census.js';
import { parseStageArgs, resolveStageClient } from './lib/stageClient.js';

export const SCRIPT_NAME = 'enable-conversation-automation';

export type EnableReason = 'bulk_enable' | 'operator_resume';

/** A refusal of the operator's INPUT (single mode: unknown id, not a
 *  one-to-one conversation). Exit 2, no partial-run banner: nothing ran. */
export class UsageError extends Error {}

export interface EnableResult {
  scanned: number;
  pointerRows: number;
  groupRows: number;
  alreadyOn: number;
  unset: number;
  breakerTrippedExcluded: number;
  /** Rows the run decided to enable (dry run: would enable). */
  planned: number;
  /** Rows actually switched on (apply only). */
  enabled: number;
  /** Planned rows by type ('(none)' for a typeless row). */
  byType: Record<string, number>;
  /** Writes whose condition failed because the row moved under the run. */
  skippedOnCondition: number;
  /** Rows switched on whose audit event could NOT be written (named at ERROR). */
  auditFailed: number;
  /** Rows the run could not PLAN (a read that threw); nothing written for them. */
  failed: number;
}

export interface EnableOpts {
  doc: DynamoDBDocumentClient;
  env: NodeJS.ProcessEnv;
  /** Write. Absent/false = dry run (the default). */
  apply?: boolean;
  /** Single mode: enable this one conversation (breaker resume). */
  conversationId?: string;
  /** Bulk mode: also enable rows with a breaker trip on record. */
  includeBreakerTripped?: boolean;
  now?: string;
  scanLimit?: number;
  logger?: Logger;
}

type Plan = 'enable' | 'already_on' | 'unset' | 'group' | 'pointer' | 'breaker_excluded';

export function planRow(
  row: ConversationItem,
  opts: { includeBreakerTripped: boolean; hasBreakerTrip: boolean },
): Plan {
  if (isPointerRow(row.conversationId)) return 'pointer';
  if (!isOneToOneBucket(row)) return 'group';
  if (row.ai_mode === 'auto') return 'already_on';
  if (row.ai_mode !== 'manual') return 'unset';
  if (opts.hasBreakerTrip && !opts.includeBreakerTripped) return 'breaker_excluded';
  return 'enable';
}

export async function enableConversationAutomation(opts: EnableOpts): Promise<EnableResult> {
  const log = opts.logger ?? defaultLogger;
  const result: EnableResult = {
    scanned: 0,
    pointerRows: 0,
    groupRows: 0,
    alreadyOn: 0,
    unset: 0,
    breakerTrippedExcluded: 0,
    planned: 0,
    enabled: 0,
    byType: {},
    skippedOnCondition: 0,
    auditFailed: 0,
    failed: 0,
  };
  try {
    await run(opts, result, log);
  } catch (err) {
    if (err instanceof UsageError) throw err; // nothing ran - no partial banner
    log.error(
      { ...result, apply: opts.apply === true },
      `${SCRIPT_NAME} - PARTIAL result: the run ABORTED and these counters cover only what completed before the failure. Every write is conditional and idempotent, so re-running after the fix is safe.`,
    );
    throw err;
  }
  return result;
}

async function run(opts: EnableOpts, result: EnableResult, log: Logger): Promise<void> {
  const { doc, env } = opts;
  const table = tableName('conversations', env);
  const apply = opts.apply === true;
  const single = opts.conversationId;
  const audit = createAuditRepo({ doc, env });
  log.info(
    { table, apply, mode: single !== undefined ? 'single' : 'bulk', ...(single !== undefined && { conversationId: single }) },
    single !== undefined ? `${SCRIPT_NAME} - single mode: targeting one conversation` : `${SCRIPT_NAME} - bulk mode`,
  );

  const enable = async (row: ConversationItem, reason: EnableReason): Promise<void> => {
    try {
      await doc.send(
        new UpdateCommand({
          TableName: table,
          Key: { conversationId: row.conversationId },
          UpdateExpression: 'SET ai_mode = :auto',
          // Still a one-to-one conversation (negative type test, typeless rows
          // included) AND still switched off: a runtime write in between loses
          // nothing, and a pointer item can never match (no ai_mode).
          ConditionExpression:
            'attribute_exists(conversationId) AND ai_mode = :manual AND ' +
            '(attribute_not_exists(#type) OR NOT #type IN (:relay, :groupText))',
          ExpressionAttributeNames: { '#type': 'type' },
          ExpressionAttributeValues: {
            ':auto': 'auto',
            ':manual': 'manual',
            ':relay': 'relay_group',
            ':groupText': 'group_text',
          },
        }),
      );
    } catch (err) {
      if (!(err instanceof ConditionalCheckFailedException)) throw err;
      result.skippedOnCondition += 1;
      log.info({ conversationId: row.conversationId }, `${SCRIPT_NAME} - row moved under the run; skipped`);
      return;
    }
    // The switch is ON from here. Whatever happens to the audit write, say so.
    result.enabled += 1;
    log.info({ conversationId: row.conversationId, reason }, `${SCRIPT_NAME} - conversation switched on`);
    try {
      await audit.append(`conversations#${row.conversationId}`, 'mode_changed', {
        from: 'manual',
        to: 'auto',
        reason,
        script: SCRIPT_NAME,
      });
    } catch (err) {
      result.auditFailed += 1;
      log.error(
        { err, conversationId: row.conversationId, reason },
        `${SCRIPT_NAME} - switched on but audit NOT written: append the mode_changed event for this conversation by hand (a re-run will report it alreadyOn)`,
      );
    }
  };

  const consider = async (row: ConversationItem, reason: EnableReason): Promise<void> => {
    result.scanned += 1;
    let plan: Plan;
    try {
      const needsTripCheck =
        !isPointerRow(row.conversationId) && isOneToOneBucket(row) && row.ai_mode === 'manual' && reason === 'bulk_enable';
      const trip = needsTripCheck ? await findBreakerTrip(doc, env, row.conversationId) : undefined;
      plan = planRow(row, { includeBreakerTripped: opts.includeBreakerTripped === true, hasBreakerTrip: trip !== undefined });
    } catch (err) {
      result.failed += 1;
      log.error({ err, conversationId: row.conversationId }, `${SCRIPT_NAME} - row could not be PLANNED; stepped over and counted failed`);
      return;
    }
    switch (plan) {
      case 'pointer':
        result.pointerRows += 1;
        return;
      case 'group':
        result.groupRows += 1;
        return;
      case 'already_on':
        result.alreadyOn += 1;
        return;
      case 'unset':
        result.unset += 1;
        return;
      case 'breaker_excluded':
        result.breakerTrippedExcluded += 1;
        log.info({ conversationId: row.conversationId }, `${SCRIPT_NAME} - breaker-tripped row excluded (pass --include-breaker-tripped or resume it singly)`);
        return;
      case 'enable': {
        result.planned += 1;
        const typeKey = typeof row.type === 'string' ? row.type : '(none)';
        result.byType[typeKey] = (result.byType[typeKey] ?? 0) + 1;
        if (apply) await enable(row, reason);
        else log.info({ conversationId: row.conversationId, type: typeKey }, `${SCRIPT_NAME} - DRY RUN: would switch on`);
        return;
      }
    }
  };

  if (single !== undefined) {
    const { Item } = await doc.send(new GetCommand({ TableName: table, Key: { conversationId: single } }));
    const row = Item as ConversationItem | undefined;
    if (!row) throw new UsageError(`${SCRIPT_NAME}: conversation ${single} not found`);
    if (isPointerRow(row.conversationId) || !isOneToOneBucket(row)) {
      throw new UsageError(`${SCRIPT_NAME}: conversation ${single} is not a one-to-one conversation - refusing`);
    }
    await consider(row, 'operator_resume');
    return;
  }

  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const page = await doc.send(
      new ScanCommand({
        TableName: table,
        ...(opts.scanLimit !== undefined && { Limit: opts.scanLimit }),
        ...(exclusiveStartKey !== undefined && { ExclusiveStartKey: exclusiveStartKey }),
      }),
    );
    for (const raw of (page.Items ?? []) as ConversationItem[]) await consider(raw, 'bulk_enable');
    exclusiveStartKey = page.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (exclusiveStartKey !== undefined);
}

/** The end-of-run report and the exit code it earns (failed or auditFailed > 0 exits 1). */
export function reportEnableRun(result: EnableResult, apply: boolean, log: Logger = defaultLogger): 0 | 1 {
  const suffix = apply ? '' : ' (DRY RUN - nothing written)';
  if (result.failed > 0 || result.auditFailed > 0) {
    log.warn(
      { ...result, apply },
      `${SCRIPT_NAME} - COMPLETED WITH FAILURES${suffix}: ${result.failed} row(s) could not be planned, ${result.auditFailed} switched on without an audit event (see the ERROR lines naming them). Investigate, then re-run (idempotent).`,
    );
    return 1;
  }
  log.info({ ...result, apply }, `${SCRIPT_NAME} - done${suffix}`);
  return 0;
}

const invokedDirectly =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('enable-conversation-automation.ts');
if (invokedDirectly) {
  const parsed = parseStageArgs(process.argv.slice(2), {
    values: ['--conversation'],
    flags: ['--apply', '--include-breaker-tripped'],
  });
  if ('usage' in parsed) {
    console.error(
      `Usage: npx tsx app/scripts/${SCRIPT_NAME}.ts --env local|dev|prod [--lane <L>] [--apply] [--conversation <id>] [--include-breaker-tripped]\n` +
        '  DRY RUN by default; --apply writes. Unknown arguments are refused. --lane selects a hermetic e2e lane (local only).',
    );
    process.exit(2);
  }
  const apply = parsed.flags.has('--apply');
  resolveStageClient(parsed.target, {}, parsed.lane !== undefined ? { lane: parsed.lane } : {})
    .then(async (stage) => {
      defaultLogger.info({ target: parsed.target, endpoint: stage.describe, prefix: stage.prefix, apply }, `${SCRIPT_NAME} - starting`);
      const result = await enableConversationAutomation({
        doc: stage.doc,
        env: stage.env,
        apply,
        ...(parsed.values.has('--conversation') && { conversationId: parsed.values.get('--conversation')! }),
        includeBreakerTripped: parsed.flags.has('--include-breaker-tripped'),
      });
      process.exitCode = reportEnableRun(result, apply);
      stage.doc.destroy();
    })
    .catch((err: unknown) => {
      if (err instanceof UsageError) {
        console.error(err.message);
        process.exitCode = 2;
        return;
      }
      defaultLogger.error({ err }, `${SCRIPT_NAME} - FAILED (see the PARTIAL report above)`);
      process.exitCode = 1;
    });
}
