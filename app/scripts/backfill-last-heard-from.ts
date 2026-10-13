// backfill-last-heard-from - the ONE-TIME backfill of contacts.last_heard_from_at
// from message history (spec
// docs/superpowers/specs/2026-10-12-last-heard-from-follow-up-status-design.md,
// sections 5.1, 5.2 and 14.2).
//
// WHAT: Scans every conversation (phone#/email#/token# claim rows skipped),
// Queries each one's INBOUND, non-retry rows newest-first (no GSI exists on
// messages), attributes each row with lib/heardFrom.ts attributeInbound - the
// ONE rule every live path uses - keeps the latest instant per contact ACROSS
// threads, then makes ONE contactsRepo.touchLastHeardFrom per contact.
// The writer is conditional and forward-only: a value a live inbound wrote
// after the scan is never moved back, and a second run writes nothing.
//
// A 1:1 thread stops at its first ATTRIBUTED inbound (an unattributed row - an
// email from an unverified address - is counted and stepped over). A GROUP
// thread (relay_group, group_text) is read to EXHAUSTION: non-members, staff
// texting from another org number, removed members and refused callers all
// sit below any roster-complete point.
//
// TARGET: --env local|dev|prod through scripts/lib/stageClient.ts. DRY RUN IS
// THE DEFAULT; --apply writes. An agent runs this ONLY with --env local
// --lane <L> against a hermetic e2e lane it started (a bare --env local is the
// human's live stack). NO AGENT RUNS THIS AGAINST A REAL ENVIRONMENT; the
// human does, dry run first, per the RUNBOOK.
//
//   npx tsx app/scripts/backfill-last-heard-from.ts --env dev
//   npx tsx app/scripts/backfill-last-heard-from.ts --env dev --apply
//
// ABORT: a touch answering 'failed' (any error but a lost condition) stops the
// run with a PARTIAL report and exit 1. Re-running after the fix is safe.
//
// PII: logs counts, contactIds and conversationIds only - never a name,
// phone, address or body.
import { QueryCommand, ScanCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { tableName } from '../src/lib/config.js';
import {
  attributeInbound,
  normalizeInstant,
  type HeardFromLookup,
  type HeardFromThread,
} from '../src/lib/heardFrom.js';
import { logger as defaultLogger, type Logger } from '../src/lib/logger.js';
import { POINTER_PARTITION_PREFIXES } from '../src/lib/unreadFeed.js';
import { createContactsRepo, type ContactsRepo } from '../src/repos/contactsRepo.js';
import type { ConversationItem } from '../src/repos/conversationsRepo.js';
import { splitTsMsgId, type MessageItem } from '../src/repos/messagesRepo.js';
import { parseStageArgs, resolveStageClient, type StageClient } from './lib/stageClient.js';

export const SCRIPT_NAME = 'backfill-last-heard-from';
/** At most this many distinct conversationIds are kept as the unattributed sample. */
export const UNATTRIBUTED_SAMPLE_MAX = 10;

const GROUP_THREAD_TYPES: ReadonlySet<string> = new Set(['relay_group', 'group_text']);

export interface HeardFromPlan {
  conversationsWalked: number;
  pointerRows: number;
  messagesRead: number;
  /** Inbound, non-retry rows the rule could not attribute. */
  unattributed: number;
  unattributedSample: string[];
  unparseableInstants: number;
  /** contactId -> the latest normalized instant, across every thread. */
  latest: Map<string, string>;
}

export function newPlan(): HeardFromPlan {
  return {
    conversationsWalked: 0,
    pointerRows: 0,
    messagesRead: 0,
    unattributed: 0,
    unattributedSample: [],
    unparseableInstants: 0,
    latest: new Map(),
  };
}

export function isPointerConversation(conversationId: unknown): boolean {
  return typeof conversationId === 'string' && POINTER_PARTITION_PREFIXES.some((p) => conversationId.startsWith(p));
}

/**
 * Plan ONE newest-first page of a thread's rows into `plan`. Rows that are not
 * inbound, or carry relay_retry_of, are ignored outright (the Query filters
 * them too; the planner re-checks so it is right on any input). Resolves true
 * when the thread is FINISHED: a 1:1 thread that attributed a row.
 */
export async function planThreadPage(
  plan: HeardFromPlan,
  thread: HeardFromThread & { conversationId: string },
  rows: readonly MessageItem[],
  lookup: HeardFromLookup,
): Promise<boolean> {
  const isGroup = GROUP_THREAD_TYPES.has(thread.type);
  plan.messagesRead += rows.length;
  for (const row of rows) {
    if (row.direction !== 'inbound') continue;
    if (typeof row.relay_retry_of === 'string' && row.relay_retry_of.length > 0) continue;
    const contactId = await attributeInbound(row, thread, lookup);
    if (contactId === undefined) {
      plan.unattributed += 1;
      if (
        plan.unattributedSample.length < UNATTRIBUTED_SAMPLE_MAX &&
        !plan.unattributedSample.includes(thread.conversationId)
      ) {
        plan.unattributedSample.push(thread.conversationId);
      }
      continue;
    }
    const at = normalizeInstant(splitTsMsgId(row.tsMsgId).providerTs);
    if (at === undefined) {
      plan.unparseableInstants += 1;
      continue;
    }
    const prior = plan.latest.get(contactId);
    if (prior === undefined || at > prior) plan.latest.set(contactId, at);
    if (!isGroup) return true;
  }
  return false;
}

export interface BackfillResult {
  conversationsWalked: number;
  pointerRows: number;
  messagesRead: number;
  unattributed: number;
  unattributedSample: string[];
  unparseableInstants: number;
  /** Contacts with a planned instant (dry run: would touch). */
  planned: number;
  written: number;
  /** No contact row, or a value already as late (a live write won). */
  skipped: number;
  failed: number;
}

export interface BackfillOpts {
  doc: DynamoDBDocumentClient;
  env: NodeJS.ProcessEnv;
  /** Write. Absent/false = dry run (the default). */
  apply?: boolean;
  /** Injectable for tests; defaults to createContactsRepo({ doc, env, logger }). */
  contacts?: Pick<ContactsRepo, 'findByPhone' | 'findByEmail' | 'touchLastHeardFrom'>;
  scanLimit?: number;
  queryLimit?: number;
  logger?: Logger;
}

function syncCounts(plan: HeardFromPlan, result: BackfillResult): void {
  result.conversationsWalked = plan.conversationsWalked;
  result.pointerRows = plan.pointerRows;
  result.messagesRead = plan.messagesRead;
  result.unattributed = plan.unattributed;
  result.unattributedSample = [...plan.unattributedSample];
  result.unparseableInstants = plan.unparseableInstants;
  result.planned = plan.latest.size;
}

export async function backfillLastHeardFrom(opts: BackfillOpts): Promise<BackfillResult> {
  const log = opts.logger ?? defaultLogger;
  const plan = newPlan();
  const result: BackfillResult = {
    conversationsWalked: 0,
    pointerRows: 0,
    messagesRead: 0,
    unattributed: 0,
    unattributedSample: [],
    unparseableInstants: 0,
    planned: 0,
    written: 0,
    skipped: 0,
    failed: 0,
  };
  try {
    await run(opts, plan, result, log);
  } catch (err) {
    syncCounts(plan, result);
    log.error(
      { ...result, apply: opts.apply === true },
      `${SCRIPT_NAME} - PARTIAL result: the run ABORTED and these counters cover only what completed before the failure. Every write is conditional and forward-only, so re-running after the fix is safe.`,
    );
    throw err;
  }
  return result;
}

async function run(opts: BackfillOpts, plan: HeardFromPlan, result: BackfillResult, log: Logger): Promise<void> {
  const contacts = opts.contacts ?? createContactsRepo({ doc: opts.doc, env: opts.env, logger: log });
  // One byPhone/byEmail Query per distinct key, however many rows name it.
  const memo = new Map<string, Promise<{ contactId: string } | undefined>>();
  const memoized = (key: string, read: () => Promise<{ contactId: string } | undefined>) => {
    let hit = memo.get(key);
    if (hit === undefined) {
      hit = read().then((c) => (c === undefined ? undefined : { contactId: c.contactId }));
      memo.set(key, hit);
    }
    return hit;
  };
  const lookup: HeardFromLookup = {
    byPhone: (e164) => memoized(`phone:${e164}`, () => contacts.findByPhone(e164)),
    byEmail: (address) => memoized(`email:${address}`, () => contacts.findByEmail(address)),
  };
  const messagesTable = tableName('messages', opts.env);

  const walkThread = async (thread: ConversationItem): Promise<void> => {
    let startKey: Record<string, unknown> | undefined;
    do {
      const page = await opts.doc.send(
        new QueryCommand({
          TableName: messagesTable,
          KeyConditionExpression: 'conversationId = :c',
          FilterExpression: '#dir = :inbound AND attribute_not_exists(#retryOf)',
          ExpressionAttributeNames: { '#dir': 'direction', '#retryOf': 'relay_retry_of' },
          ExpressionAttributeValues: { ':c': thread.conversationId, ':inbound': 'inbound' },
          ScanIndexForward: false,
          ...(opts.queryLimit !== undefined && { Limit: opts.queryLimit }),
          ...(startKey !== undefined && { ExclusiveStartKey: startKey }),
        }),
      );
      if (await planThreadPage(plan, thread, (page.Items ?? []) as MessageItem[], lookup)) return;
      startKey = page.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (startKey !== undefined);
  };

  let scanKey: Record<string, unknown> | undefined;
  do {
    const page = await opts.doc.send(
      new ScanCommand({
        TableName: tableName('conversations', opts.env),
        ...(opts.scanLimit !== undefined && { Limit: opts.scanLimit }),
        ...(scanKey !== undefined && { ExclusiveStartKey: scanKey }),
      }),
    );
    for (const raw of (page.Items ?? []) as ConversationItem[]) {
      if (isPointerConversation(raw.conversationId)) {
        plan.pointerRows += 1;
        continue;
      }
      plan.conversationsWalked += 1;
      await walkThread(raw);
    }
    scanKey = page.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (scanKey !== undefined);

  syncCounts(plan, result);
  log.info({ ...result, apply: opts.apply === true }, `${SCRIPT_NAME} - planned`);
  if (opts.apply !== true) return;

  // contactId order: deterministic logs and a deterministic abort point.
  for (const [contactId, at] of [...plan.latest].sort(([a], [b]) => a.localeCompare(b))) {
    const outcome = await contacts.touchLastHeardFrom(contactId, at);
    if (outcome === 'written') result.written += 1;
    else if (outcome === 'skipped') result.skipped += 1;
    else {
      result.failed += 1;
      log.error({ contactId }, `${SCRIPT_NAME} - touch FAILED (not a lost condition) - aborting`);
      throw new Error(`${SCRIPT_NAME}: touchLastHeardFrom failed for ${contactId}`);
    }
  }
}

/** The end-of-run report (exit 0: a failed touch has already aborted). */
export function reportBackfillRun(result: BackfillResult, apply: boolean, log: Logger = defaultLogger): 0 {
  log.info({ ...result, apply }, `${SCRIPT_NAME} - done${apply ? '' : ' (DRY RUN - nothing written)'}`);
  return 0;
}

const invokedDirectly =
  import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith(`${SCRIPT_NAME}.ts`);
if (invokedDirectly) {
  const parsed = parseStageArgs(process.argv.slice(2), { values: [], flags: ['--apply'] });
  if ('usage' in parsed) {
    console.error(
      `Usage: npx tsx app/scripts/${SCRIPT_NAME}.ts --env local|dev|prod [--lane <L>] [--apply]\n` +
        '  DRY RUN by default; --apply writes. Unknown or repeated arguments are refused. --lane selects a hermetic e2e lane\n' +
        '  (local only). An agent uses --env local --lane <L> ONLY.',
    );
    process.exit(2);
  }
  const apply = parsed.flags.has('--apply');
  void (async () => {
    // STEP 1 - resolve the target on its own: a refusal here happens BEFORE any
    // table is read, so it must never point the operator at a PARTIAL report.
    let stage: StageClient;
    try {
      stage = await resolveStageClient(parsed.target, {}, parsed.lane !== undefined ? { lane: parsed.lane } : {});
    } catch (err) {
      defaultLogger.error({ err }, `${SCRIPT_NAME} - FAILED before the run started (no table was read or written)`);
      process.exitCode = 1;
      return;
    }
    // STEP 2 - the run.
    try {
      defaultLogger.info(
        { target: parsed.target, endpoint: stage.describe, prefix: stage.prefix, apply },
        `${SCRIPT_NAME} - starting`,
      );
      const result = await backfillLastHeardFrom({ doc: stage.doc, env: stage.env, apply });
      process.exitCode = reportBackfillRun(result, apply);
    } catch (err) {
      defaultLogger.error({ err }, `${SCRIPT_NAME} - FAILED (see the PARTIAL report above)`);
      process.exitCode = 1;
    } finally {
      stage.doc.destroy();
    }
  })();
}
