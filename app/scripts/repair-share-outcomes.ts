// repair-share-outcomes - share-sent-outcome spec D8: a Cameron-run,
// DRY-RUN-FIRST, re-runnable repair that brings EXISTING property sends (the
// share rows, their retry chains and the listing-send ledger) in line with the
// rule the deployed code now keeps: a retry's outcome reaches its share slot,
// and the ledger follows the slot.
//
// WHY. Before this branch a retry of a share text never reached the share's
// recipient slot (the status webhook skipped every retry row); rows appended
// before retry-send-adoption carry no `broadcast_id` / `retry_root`, so their
// receipts route to no slot even now; a lost rollup can leave a slot stuck
// `sent` while its own row failed; a dropped write at the retry job's two arms
// leaves a done/unresolved record the slot never learned; and the ledger (the
// "Properties sent" / "Sent to tenants" rows) was written at acceptance alone.
// The live writers heal none of that retroactively.
//
// WHAT, per unit-targeted share (ONE Scan of the broadcasts table filtered to
// rows with a unitId - plan deviation 1; `--broadcast <id>` reads one share
// instead), per slot that is not skipped and carries a message pointer:
//   1. THE CHAIN: the original row O (the slot's conversationId + tsMsgId) and
//      the conversation's rows newer than O whose retry_of walk reaches O
//      within those rows (paged newest-first, CHAIN_PAGE_LIMIT at a time, until
//      a page reaches O). A row that walks elsewhere belongs to ANOTHER chain -
//      another share's text, or another slot's chain in the same thread (two
//      contacts on one number share a conversation, so broadcast_id says
//      nothing about which slot a row belongs to) - and is ignored. A row that
//      CLAIMS O (retry_root = O) but does not walk to it is a BROKEN link: the
//      slot is unjudgeable (brokenLineage) and left alone, as is a slot whose
//      O is missing (originalMissing) - its ledger row too.
//   2. STAMPS: every chain row whose broadcast_id is not this share, or whose
//      retry_root is not O (missing OR wrong: 1b's legacy walk stops at its hop
//      cap or at a broken link), through the ONE conditional
//      messagesRepo.stampRetryAttribution.
//   3. THE DECIDED ATTEMPT (D2's rule applied to history): the LATEST
//      delivered row of [O, chain] - a delivery is never erased (I2). Else the
//      newest row N (O when the chain is empty) by its status (failed /
//      undelivered: failed with its code and its promise; sent: carrier-
//      CONFIRMED - only the carrier's sent callback moves a row there - at the
//      row's own provider instant, a sound lower bound; queued: a bare
//      acceptance), and then ONE check of N's
//      NEXT attempt: N's retry_outcome 'unconfirmed', or its retry_send record
//      (retry#<conversation>#<N>#<attempt>, keyed by retryRecipientKey)
//      done/unresolved, or reconciling past the reconcile's schedule with no
//      chain row after N, decide a ROW-LESS unresolved attempt (<N>~). A
//      recipient key that cannot be derived skips ONLY the record read
//      (noRecipientKey); the decision stands on the rows.
//   4. THE SLOT is "to move" when the D2 rule admits the decided attempt
//      (wouldApply) and the slot does not already record it. The apply moves
//      it through applyLaterAttempt - the D2 rule again, on a consistent read -
//      so the repair never regresses a slot: never a delivered or skipped
//      slot, never a slot an attempt newer than the census has touched.
//   5. THE LEDGER FOLLOWS THE SLOT, never the decision: the entry the slot's
//      own state implies (ledgerEntryForSlot - the projected slot on a census,
//      the re-read slot on an apply; a delivered slot that refused the move
//      keeps its delivery-counted entry) for the pair's contact (the slot key
//      when it is a contact id, else N's recipient_contact_id, else noContact),
//      compared with the stored row by the service's own rule
//      (ledgerWouldChange) and, on an apply, written through
//      applyShareLedgerEntry (a refused no-op when applyLaterAttempt already
//      wrote it as the slot moved).
// Every write is conditional: slots through applyLaterAttempt, ledger rows
// through applyShareLedgerEntry, rows through stampRetryAttribution - this
// script never Puts or Updates a share or a ledger row itself.
//
// THE REPORT (RepairReport). The *To* counters are the CENSUS's forecast -
// counted on a dry run AND on an apply; the past-tense counters are what the
// apply wrote (always 0 on a dry run). On an apply, a past-tense counter below
// its forecast means a live writer changed that slot or pair during the run
// (the rule refused, correctly), or the slot's write failed (slotsFailed): a
// second run reports what is still left.
//
// A FAILED WRITE IS PER SLOT (code review ADV-4): a slot or ledger write that
// throws (a permanent per-item cause - DynamoDB's 400 KB item limit on a share
// stored under the old 1500 cap - fails on every re-run) or answers 'lost' is
// ONE ERROR naming the share and slot, counted in slotsFailed, and the walk
// goes on to the next slot: one bad share never blocks every share after it.
// A READ that fails still aborts the run (there is nothing to continue from).
//
// EXIT: 0 = the run completed clean (a dry run or an apply); 1 = the run
// completed with slotsFailed > 0 (the full report is logged first, COMPLETED
// WITH FAILURES), or a read failed (the PARTIAL report is logged first; every
// write is conditional and idempotent, so re-running after the fix is safe),
// or the target could not be resolved (no table read); 2 = usage (an unknown or
// repeated argument, --lane off local, an unknown --broadcast id).
//
// TARGET: `--env local|dev|prod` through scripts/lib/stageClient.ts; dev/prod
// run the account guard on the housingchoice profile FIRST, before any table
// is read. DRY RUN IS THE DEFAULT; `--apply` writes. NO AGENT RUNS THIS AGAINST
// DEV OR PROD: Cameron does, once after this branch deploys and before the next
// blast, per the RUNBOOK. An agent rehearses on a hermetic lane it started
// (`--env local --lane <L>`), never a bare `--env local` (the live local stack).
//
//   npx tsx app/scripts/repair-share-outcomes.ts --env dev
//   npx tsx app/scripts/repair-share-outcomes.ts --env dev --apply
//   npx tsx app/scripts/repair-share-outcomes.ts --env dev --broadcast <id>
//
// PII: logs ids and counts only - broadcastId, conversationId, tsMsgId, unit
// and contact ids, attempt keys, states. A slot key that is `phone#<E164>` is
// logged redacted (safeRecipientKey). Never a name, a phone or a body.
import { ScanCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { tableName } from '../src/lib/config.js';
import { createEventBus } from '../src/lib/events.js';
import { logger as defaultLogger, type Logger } from '../src/lib/logger.js';
import { isRetryPromiseLive, RETRY_OUTCOME_UNCONFIRMED, RETRY_PROMISE_GRACE_MS } from '../src/lib/retrySendWindow.js';
import { safeRecipientKey } from '../src/lib/sendFingerprint.js';
import { RECONCILE_CHECK_DELAYS_MS, SEND_UNCONFIRMED_CODE } from '../src/lib/sendOutcome.js';
import { attemptKeyTimestampMs, compareAttemptKeys, rowlessAttemptKey } from '../src/lib/shareAttemptOrder.js';
import { createBroadcastsRepo, type BroadcastItem, type BroadcastRecipient, type BroadcastsRepo } from '../src/repos/broadcastsRepo.js';
import { createConversationsRepo, type ConversationItem, type ConversationsRepo } from '../src/repos/conversationsRepo.js';
import { createListingSendsRepo, type ListingSendsRepo } from '../src/repos/listingSendsRepo.js';
import { createMessagesRepo, type MessageItem, type MessagesRepo } from '../src/repos/messagesRepo.js';
import { createSendAttemptsRepo, type SendAttemptRecord, type SendAttemptsRepo } from '../src/repos/sendAttemptsRepo.js';
import { retryRecipientKey } from '../src/services/retryChain.js';
import {
  applyLaterAttempt,
  pairContactId,
  projectSlot,
  wouldApply,
  type ApplyResult,
  type AttemptOutcome,
  type ShareAttemptOutcomeDeps,
} from '../src/services/shareAttemptOutcome.js';
import {
  applyShareLedgerEntry,
  ledgerEntryCounts,
  ledgerEntryForSlot,
  ledgerRowCounted,
  ledgerWouldChange,
  type ShareLedgerDeps,
} from '../src/services/shareLedger.js';
import {
  parseStageArgs,
  resolveStageClient,
  type StageClient,
  type StageClientDeps,
  type StageClientOpts,
  type StageTarget,
} from './lib/stageClient.js';

export const SCRIPT_NAME = 'repair-share-outcomes';

/** Rows per page of a slot's chain collection (newest first, `before` the oldest row seen). */
export const CHAIN_PAGE_LIMIT = 100;

/**
 * A `reconciling` retry record whose attempt started longer ago than the
 * reconcile's own schedule (its LAST check, plus the promise grace) is the
 * trace of the enqueue arm's first crash window (spec D2, D8 step 3): nothing
 * revisits it, so its chain ended unresolved. The production schedule is the
 * reference; a lane's shortened delays only make its records stale sooner.
 */
export const STALE_RECONCILING_MS = RECONCILE_CHECK_DELAYS_MS[2]! + RETRY_PROMISE_GRACE_MS;

/** A refusal of the operator's INPUT (an unknown --broadcast id): exit 2, no partial-run banner - nothing ran. */
export class UsageError extends Error {}

export interface RepairReport {
  /** Unit-targeted shares walked. */
  sharesWalked: number;
  /** Slots walked: every slot that is not skipped and carries a message pointer (conversationId + tsMsgId). */
  slotsWalked: number;
  /** Census: chain rows whose broadcast_id or retry_root is missing or wrong. */
  stampsNeeded: number;
  /** Apply: chain rows stamped. */
  stampsWritten: number;
  /** Census: slots the D2 rule would move to their decided attempt. */
  slotsToMove: number;
  /** Apply: slots moved. */
  slotsMoved: number;
  /** Census: pairs with no ledger row that would get one (counted or not - a failed entry is memory too). */
  rowsToCreate: number;
  /** Apply: ledger rows created. */
  rowsCreated: number;
  /** Census: pairs that would start counting ("Properties sent" lists them again), a created counted row included. */
  pairsToRecount: number;
  /** Apply: pairs that started counting. */
  pairsRecounted: number;
  /** Census: pairs that would stop counting (they leave "Properties sent"). */
  pairsToUncount: number;
  /** Apply: pairs that stopped counting. */
  pairsUncounted: number;
  /**
   * Apply: slots whose slot or ledger write failed - it threw, or its
   * condition kept losing past the re-read bound. Each is named on ONE ERROR
   * line and left as it is; the walk went on; the run exits 1.
   */
  slotsFailed: number;
  /** Slots (or their ledger step) the repair could not judge and left as they are. */
  unjudgeable: {
    /** The slot's original message row is missing (a deleted conversation): slot and ledger row untouched. */
    originalMissing: number;
    /** A row claims this original (retry_root) but its retry_of walk does not reach it: slot and ledger row untouched. */
    brokenLineage: number;
    /** A phone-keyed slot whose newest row names no contact: the slot step ran, the ledger was left. */
    noContact: number;
    /** No recipient key for the newest attempt's retry record (no recorded contact, no thread number): the record check was skipped, the slot decided on its rows. */
    noRecipientKey: number;
  };
}

export interface RepairOptions {
  doc: DynamoDBDocumentClient;
  /** Carries the stage's TABLE_PREFIX (StageClient.env). */
  env: NodeJS.ProcessEnv;
  /** Write. false = the census (a dry run). */
  apply: boolean;
  /** The run's clock (a promise's liveness, a record's staleness); read ONCE at the start. */
  now?: () => number;
  /** Items per Scan page (bulk mode). */
  scanLimit?: number;
  /** One-share mode: walk this share only (an unknown id is a UsageError). */
  broadcastId?: string;
  logger?: Logger;
}

type UnitShare = BroadcastItem & { unitId: string };

/** A slot's attempt chain: its original row and the rows that walk to it, oldest first. */
interface ChainRows {
  original: MessageItem;
  rows: MessageItem[];
}
type Chain = ChainRows | { unjudgeable: 'originalMissing' | 'brokenLineage' };

/** The attempt a slot's history decides: its order key and what it ended as. */
interface Decided {
  attemptKey: string;
  outcome: AttemptOutcome;
}

interface Repos {
  broadcasts: BroadcastsRepo;
  messages: MessagesRepo;
  attempts: SendAttemptsRepo;
  listingSends: ListingSendsRepo;
  conversations: ConversationsRepo;
}

/** Everything one slot's repair reads from and counts into. */
interface SlotRun {
  repos: Repos;
  slotDeps: ShareAttemptOutcomeDeps;
  ledger: ShareLedgerDeps;
  log: Logger;
  report: RepairReport;
  apply: boolean;
  nowMs: number;
  share: UnitShare;
  contactKey: string;
  slot: BroadcastRecipient;
  conversationId: string;
  originalKey: string;
  /** Conversation reads, cached per share (two slots of one share can share a thread). */
  conversations: Map<string, ConversationItem | undefined>;
}

function emptyReport(): RepairReport {
  return {
    sharesWalked: 0,
    slotsWalked: 0,
    stampsNeeded: 0,
    stampsWritten: 0,
    slotsToMove: 0,
    slotsMoved: 0,
    rowsToCreate: 0,
    rowsCreated: 0,
    pairsToRecount: 0,
    pairsRecounted: 0,
    pairsToUncount: 0,
    pairsUncounted: 0,
    slotsFailed: 0,
    unjudgeable: { originalMissing: 0, brokenLineage: 0, noContact: 0, noRecipientKey: 0 },
  };
}

function nonEmpty(value: string | undefined): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function isUnitShare(item: BroadcastItem): item is UnitShare {
  return typeof item.unitId === 'string' && item.unitId.length > 0;
}

/**
 * The census (apply = false) or the repair (apply = true) - see the header.
 * Never throws for a slot it cannot judge (it counts it) nor for a slot whose
 * slot or ledger WRITE fails (ONE ERROR, slotsFailed, the walk goes on); a
 * READ failure ABORTS the run: the PARTIAL report is logged at ERROR, then the
 * error propagates. An unknown --broadcast id is a UsageError (nothing ran).
 */
export async function runRepairShareOutcomes(opts: RepairOptions): Promise<RepairReport> {
  const log = opts.logger ?? defaultLogger;
  const report = emptyReport();
  try {
    await walk(opts, report, log);
  } catch (err) {
    if (err instanceof UsageError) throw err;
    log.error(
      { ...report, apply: opts.apply },
      `${SCRIPT_NAME} - PARTIAL report: the run ABORTED and these counters cover only what completed before the failure. Every write is conditional and idempotent, so re-running after the fix is safe.`,
    );
    throw err;
  }
  return report;
}

async function walk(opts: RepairOptions, report: RepairReport, log: Logger): Promise<void> {
  const deps = { doc: opts.doc, env: opts.env, logger: log };
  const repos: Repos = {
    broadcasts: createBroadcastsRepo(deps),
    messages: createMessagesRepo(deps),
    attempts: createSendAttemptsRepo(deps),
    listingSends: createListingSendsRepo(deps),
    conversations: createConversationsRepo(deps),
  };
  const nowMs = (opts.now ?? Date.now)();
  const ledger: ShareLedgerDeps = { listingSends: repos.listingSends, log };
  // applyLaterAttempt's broadcast.updated emit goes to a bus of its own with
  // no listener: a script reaches no dashboard (they read the rows on their
  // next fetch).
  const slotDeps: ShareAttemptOutcomeDeps = {
    broadcasts: repos.broadcasts,
    ledger,
    events: createEventBus({ logger: log }),
    log,
    now: () => nowMs,
  };
  log.info(
    { apply: opts.apply, ...(opts.broadcastId !== undefined ? { broadcastId: opts.broadcastId } : { mode: 'every unit-targeted share' }) },
    `${SCRIPT_NAME} - walking${opts.apply ? '' : ' (DRY RUN - nothing is written)'}`,
  );
  for await (const share of unitShares(repos, opts, log)) {
    report.sharesWalked += 1;
    const conversations = new Map<string, ConversationItem | undefined>();
    for (const [contactKey, slot] of Object.entries(share.recipients ?? {})) {
      if (slot.status === 'skipped' || slot.conversationId === undefined || slot.tsMsgId === undefined) continue;
      report.slotsWalked += 1;
      await repairSlot({
        repos,
        slotDeps,
        ledger,
        log,
        report,
        apply: opts.apply,
        nowMs,
        share,
        contactKey,
        slot,
        conversationId: slot.conversationId,
        originalKey: slot.tsMsgId,
        conversations,
      });
    }
  }
}

/** The shares to walk: ONE consistent Scan filtered to unit-targeted rows (paged), or the one --broadcast share. */
async function* unitShares(repos: Repos, opts: RepairOptions, log: Logger): AsyncGenerator<UnitShare> {
  if (opts.broadcastId !== undefined) {
    const share = await repos.broadcasts.getByIdConsistent(opts.broadcastId);
    if (share === undefined) {
      throw new UsageError(`${SCRIPT_NAME}: broadcast ${opts.broadcastId} not found - refusing (nothing was walked)`);
    }
    if (!isUnitShare(share)) {
      log.info({ broadcastId: share.broadcastId }, `${SCRIPT_NAME} - not a unit-targeted share (no unitId): not walked`);
      return;
    }
    yield share;
    return;
  }
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const page = await opts.doc.send(
      new ScanCommand({
        TableName: tableName('broadcasts', opts.env),
        FilterExpression: 'attribute_exists(#unit)',
        ExpressionAttributeNames: { '#unit': 'unitId' },
        ConsistentRead: true,
        ...(opts.scanLimit !== undefined && { Limit: opts.scanLimit }),
        ...(exclusiveStartKey !== undefined && { ExclusiveStartKey: exclusiveStartKey }),
      }),
    );
    for (const item of (page.Items ?? []) as BroadcastItem[]) {
      if (isUnitShare(item)) yield item;
    }
    exclusiveStartKey = page.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (exclusiveStartKey !== undefined);
}

/**
 * THE CHAIN of a slot (header step 1): O read consistently; the thread's rows
 * newer than O collected newest-first until a page reaches O; kept when their
 * retry_of walk reaches O through collected rows only. A collected row that
 * claims O (retry_root) but does not walk to it breaks the slot's lineage.
 */
async function rebuildChain(messages: MessagesRepo, conversationId: string, originalKey: string): Promise<Chain> {
  const original = await messages.getByTsMsgIdConsistent(conversationId, originalKey);
  if (original === undefined) return { unjudgeable: 'originalMissing' };
  const newer = new Map<string, MessageItem>();
  let before: string | undefined;
  for (;;) {
    const page = await messages.listByConversation(conversationId, { limit: CHAIN_PAGE_LIMIT, ...(before !== undefined && { before }) });
    for (const row of page) {
      if (row.tsMsgId > originalKey) newer.set(row.tsMsgId, row);
    }
    const oldest = page[page.length - 1]?.tsMsgId;
    if (oldest === undefined || oldest <= originalKey) break;
    before = oldest;
  }
  const reach = new Map<string, boolean>();
  const walksToOriginal = (start: MessageItem): boolean => {
    const path: string[] = [];
    let current: MessageItem | undefined = start;
    let answer = false;
    while (current !== undefined) {
      const known = reach.get(current.tsMsgId);
      if (known !== undefined) {
        answer = known;
        break;
      }
      if (path.includes(current.tsMsgId)) break; // a cycle: malformed lineage, walks nowhere
      path.push(current.tsMsgId);
      const parent = nonEmpty(current.retry_of);
      if (parent === undefined) break; // not a retry row (or a chain that started elsewhere)
      if (parent === originalKey) {
        answer = true;
        break;
      }
      current = newer.get(parent); // undefined: the walk leaves the collection
    }
    for (const id of path) reach.set(id, answer);
    return answer;
  };
  const rows: MessageItem[] = [];
  for (const row of newer.values()) {
    if (walksToOriginal(row)) rows.push(row);
    else if (row.retry_root === originalKey) return { unjudgeable: 'brokenLineage' };
  }
  rows.sort((a, b) => compareAttemptKeys(a.tsMsgId, b.tsMsgId));
  return { original, rows };
}

/**
 * What a row's own status says about its attempt. A row reaches `sent` only
 * through the carrier's sent callback, so a `sent` row is carrier-CONFIRMED:
 * the outcome carries the row's own provider instant (the ISO in its key - a
 * sound lower bound; a message row stores no carrier instant of its own), and
 * the slot reads Sent, not Sending (code review ADV-5). `queued` (the
 * provider's acceptance) and `queued_pending` stay a bare acceptance.
 */
function rowOutcome(row: MessageItem): AttemptOutcome {
  switch (row.delivery_status) {
    case 'delivered':
      return { kind: 'delivered' };
    case 'failed':
    case 'undelivered':
      return {
        kind: 'failed',
        errorCode: row.error_code ?? 'unknown',
        ...(typeof row.retry_due_at === 'string' && { retryDueAt: row.retry_due_at }),
      };
    case 'sent': {
      const at = attemptKeyTimestampMs(row.tsMsgId);
      return { kind: 'sent', ...(at !== undefined && { carrierSentAt: new Date(at).toISOString() }) };
    }
    default:
      // queued (the provider's acceptance), queued_pending
      return { kind: 'sent' };
  }
}

/** A done/unresolved record, or a reconciling one past the reconcile's schedule with no chain row after the attempt it retried. */
function chainEndedUnresolved(record: SendAttemptRecord, rows: MessageItem[], newest: MessageItem, nowMs: number): boolean {
  if (record.state === 'done') return record.outcome === 'unresolved';
  if (record.state !== 'reconciling') return false;
  const startedMs = Date.parse(record.attemptedAt);
  return Number.isFinite(startedMs) && nowMs - startedMs > STALE_RECONCILING_MS && !rows.some((row) => row.retry_of === newest.tsMsgId);
}

async function conversationOf(r: SlotRun): Promise<ConversationItem | undefined> {
  if (!r.conversations.has(r.conversationId)) {
    r.conversations.set(r.conversationId, await r.repos.conversations.getById(r.conversationId));
  }
  return r.conversations.get(r.conversationId);
}

/** THE DECIDED ATTEMPT (header step 3): the delivered exception first, else the newest row and ONE check of its next attempt. */
async function decideAttempt(r: SlotRun, chain: ChainRows, newest: MessageItem, ids: Record<string, unknown>): Promise<Decided> {
  let delivered: MessageItem | undefined;
  for (const row of [chain.original, ...chain.rows]) {
    if (row.delivery_status === 'delivered') delivered = row;
  }
  if (delivered !== undefined) return { attemptKey: delivered.tsMsgId, outcome: { kind: 'delivered' } };
  const fromRow: Decided = { attemptKey: newest.tsMsgId, outcome: rowOutcome(newest) };
  const unresolved: Decided = { attemptKey: rowlessAttemptKey(newest.tsMsgId), outcome: { kind: 'unresolved' } };
  // The row's own trace needs no record read: 1b's WITHDRAW stamped it when
  // the reconcile ruled its retry unresolved (on a share's own row too).
  if (newest.retry_outcome === RETRY_OUTCOME_UNCONFIRMED) return unresolved;
  // The thread's number is read only when the row names no contact.
  const conversation = nonEmpty(newest.recipient_contact_id) === undefined ? await conversationOf(r) : undefined;
  const recipientKey = retryRecipientKey(newest, conversation);
  if (recipientKey === undefined) {
    r.report.unjudgeable.noRecipientKey += 1;
    r.log.info(
      { ...ids, attempt: newest.tsMsgId },
      `${SCRIPT_NAME} - no recipient key for the newest attempt's retry record (no recorded contact, no thread number): record check skipped, the slot decides on its rows`,
    );
    return fromRow;
  }
  const record = await r.repos.attempts.get({
    kind: 'retry_send',
    conversationId: r.conversationId,
    retriedTsMsgId: newest.tsMsgId,
    attempt: (newest.retry_attempt ?? 0) + 1,
    recipientKey,
    retryRoot: chain.original.tsMsgId,
  });
  if (record !== undefined && chainEndedUnresolved(record, chain.rows, newest, r.nowMs)) return unresolved;
  return fromRow;
}

/** The slot already records the decided attempt with its status and code (a second run finds every moved slot here). */
function slotRecords(slot: BroadcastRecipient, decided: Decided): boolean {
  const o = decided.outcome;
  const status = o.kind === 'unresolved' ? 'failed' : o.kind;
  const code = o.kind === 'failed' ? o.errorCode : o.kind === 'unresolved' ? SEND_UNCONFIRMED_CODE : undefined;
  return (slot.latestAttempt ?? slot.tsMsgId) === decided.attemptKey && slot.status === status && slot.errorCode === code;
}

/**
 * A slot or ledger WRITE failed for one slot (code review ADV-4): ONE ERROR
 * with the ids (the slot key redacted) and the error - or `result: 'lost'`
 * for a condition that kept losing past the re-read bound - counted in
 * slotsFailed; the caller leaves the slot as it is and the walk goes on.
 * Returns true (the caller's failed flag).
 */
function failSlot(
  r: Pick<SlotRun, 'log' | 'report'>,
  ids: Record<string, unknown>,
  step: 'slot' | 'ledger',
  cause: { err: unknown } | { result: 'lost' },
): true {
  r.report.slotsFailed += 1;
  r.log.error(
    { ...ids, step, ...cause },
    `${SCRIPT_NAME} - the ${step} write failed for this slot: counted in slotsFailed and left as it is, the walk goes on (fix the cause and re-run)`,
  );
  return true;
}

/** One slot: chain, stamps, decision, slot step, ledger step (header steps 1-5). */
async function repairSlot(r: SlotRun): Promise<void> {
  const { repos, log, report, apply, share, contactKey, slot, conversationId, originalKey } = r;
  const ids = { broadcastId: share.broadcastId, recipientKey: safeRecipientKey(contactKey), conversationId, tsMsgId: originalKey };

  // 1. THE CHAIN.
  const chain = await rebuildChain(repos.messages, conversationId, originalKey);
  if ('unjudgeable' in chain) {
    report.unjudgeable[chain.unjudgeable] += 1;
    log.info({ ...ids, reason: chain.unjudgeable }, `${SCRIPT_NAME} - slot not judgeable: left as it is, its ledger row too`);
    return;
  }

  // 2. STAMPS.
  for (const row of chain.rows) {
    if (row.broadcast_id === share.broadcastId && row.retry_root === originalKey) continue;
    report.stampsNeeded += 1;
    const stamp = {
      ...ids,
      row: row.tsMsgId,
      retryRoot: originalKey,
      ...(typeof row.broadcast_id === 'string' && { hadBroadcastId: row.broadcast_id }),
      ...(typeof row.retry_root === 'string' && { hadRetryRoot: row.retry_root }),
    };
    if (!apply) {
      log.info(stamp, `${SCRIPT_NAME} - DRY RUN: would stamp the retry row's broadcast_id and retry_root`);
      continue;
    }
    if (await repos.messages.stampRetryAttribution(conversationId, row.tsMsgId, { broadcastId: share.broadcastId, retryRoot: originalKey })) {
      report.stampsWritten += 1;
    } else {
      log.warn(stamp, `${SCRIPT_NAME} - the retry row is gone since the chain was read: not stamped`);
    }
  }

  // 3. THE DECIDED ATTEMPT.
  const newest = chain.rows[chain.rows.length - 1] ?? chain.original;
  const decided = await decideAttempt(r, chain, newest, ids);

  // The pair's ledger row is read BEFORE this slot's writes: applyLaterAttempt
  // writes it too when the slot moves, and the apply's counters compare the
  // row before with the row after - never a service's return. The pair's
  // contact is the live writers' own rule (pairContactId).
  const contactId = pairContactId(contactKey, nonEmpty(newest.recipient_contact_id));
  const before = contactId === undefined ? undefined : await repos.listingSends.getByKeyConsistent(share.unitId, contactId);

  // 4. THE SLOT.
  const moves = wouldApply(slot, decided) && !slotRecords(slot, decided);
  const projected = moves ? projectSlot(slot, decided) : slot;
  let current: BroadcastRecipient | undefined = slot;
  let slotWriteFailed = false;
  if (moves) {
    report.slotsToMove += 1;
    const move = { ...ids, attempt: decided.attemptKey, outcome: decided.outcome.kind, from: slot.status, to: projected.status };
    if (!apply) {
      log.info(move, `${SCRIPT_NAME} - DRY RUN: would move the slot to its decided attempt`);
    } else {
      const recipientContactId = nonEmpty(newest.recipient_contact_id);
      let result: ApplyResult | undefined;
      try {
        result = await applyLaterAttempt(r.slotDeps, {
          broadcastId: share.broadcastId,
          conversationId,
          retryRoot: originalKey,
          attemptKey: decided.attemptKey,
          outcome: decided.outcome,
          ...(recipientContactId !== undefined && { recipientContactId }),
        });
      } catch (err) {
        slotWriteFailed = failSlot(r, ids, 'slot', { err });
      }
      if (result === 'lost') slotWriteFailed = failSlot(r, ids, 'slot', { result: 'lost' });
      else if (result === 'applied') report.slotsMoved += 1;
      else if (result !== undefined) {
        log.info({ ...move, result }, `${SCRIPT_NAME} - slot not moved: refused on a fresh read (a newer attempt landed after the census), or the share or the slot is gone`);
      }
      if (!slotWriteFailed) current = (await repos.broadcasts.getByIdConsistent(share.broadcastId))?.recipients?.[contactKey];
    }
  }

  // 5. THE LEDGER FOLLOWS THE SLOT.
  if (contactId === undefined) {
    report.unjudgeable.noContact += 1;
    log.info(ids, `${SCRIPT_NAME} - no contact for the pair (a phone-keyed slot whose newest row names none): the ledger is left as it is`);
    return;
  }
  const promiseLive = isRetryPromiseLive(newest.retry_due_at, r.nowMs);
  const pair = { broadcastId: share.broadcastId, unitId: share.unitId, contactId };
  const forecast = ledgerEntryForSlot(projected, conversationId, promiseLive);
  if (forecast !== undefined) {
    const change = ledgerWouldChange(before, share.broadcastId, forecast);
    if (change === 'create') {
      report.rowsToCreate += 1;
      if (ledgerEntryCounts(forecast)) report.pairsToRecount += 1;
    } else if (change === 'recount') report.pairsToRecount += 1;
    else if (change === 'uncount') report.pairsToUncount += 1;
    if (!apply && change !== 'none') {
      log.info({ ...pair, change, attempt: forecast.attempt, state: forecast.state }, `${SCRIPT_NAME} - DRY RUN: would write the pair's ledger entry`);
    }
  }
  if (!apply) return;
  // The slot's write failed: its ERROR line names it, and its ledger row is
  // left for the re-run that moves the slot (the ledger follows the SLOT).
  if (slotWriteFailed) return;
  if (current === undefined) {
    log.warn(ids, `${SCRIPT_NAME} - the share or its slot is gone since the census: its ledger row is left as it is`);
    return;
  }
  const entry = ledgerEntryForSlot(current, conversationId, promiseLive);
  if (entry !== undefined) {
    let written: 'written' | 'refused' | 'lost';
    try {
      written = await applyShareLedgerEntry(r.ledger, { unitId: share.unitId, contactId, broadcastId: share.broadcastId, entry });
    } catch (err) {
      failSlot(r, ids, 'ledger', { err });
      return;
    }
    if (written === 'lost') {
      failSlot(r, ids, 'ledger', { result: 'lost' });
      return;
    }
  } else if (!moves) {
    return; // nothing wrote this pair
  }
  const after = await repos.listingSends.getByKeyConsistent(share.unitId, contactId);
  if (before === undefined && after !== undefined) report.rowsCreated += 1;
  const was = ledgerRowCounted(before);
  const is = ledgerRowCounted(after);
  if (!was && is) report.pairsRecounted += 1;
  if (was && !is) report.pairsUncounted += 1;
}

/**
 * The end-of-run report and the exit code it earns: 1 when a slot's write
 * failed (slotsFailed > 0 - the run completed and the FULL report is logged
 * first, each failed slot on its own ERROR line), else 0. A read failure
 * never gets here: it throws first and exits 1 from the entrypoint.
 */
export function reportRepair(report: RepairReport, apply: boolean, log: Logger = defaultLogger): number {
  const suffix = apply
    ? ' (APPLY - the *To* counters are the census forecast, the past-tense ones what was written)'
    : ' (DRY RUN - nothing written; the *To* counters forecast an apply)';
  if (report.slotsFailed > 0) {
    log.warn(
      { ...report, apply },
      `${SCRIPT_NAME} - COMPLETED WITH FAILURES${suffix}: ${report.slotsFailed} slot(s) could not be written and were left as they are (see the ERROR lines naming them). Fix the cause, then re-run (idempotent).`,
    );
    return 1;
  }
  log.info({ ...report, apply }, `${SCRIPT_NAME} - done${suffix}`);
  return 0;
}

/**
 * STEP 1 of a run, on its own: resolve the target - the tables AND the
 * credentials - through the shared stage resolver. For dev/prod the account
 * guard runs FIRST and refuses any account but housingchoice's before a
 * client is even built, so a refusal here means no table was read or written.
 */
export async function resolveTargetForRepair(
  target: StageTarget,
  deps: StageClientDeps = {},
  opts: StageClientOpts = {},
): Promise<StageClient> {
  return resolveStageClient(target, deps, opts);
}

/** The CLI: `--env` (required), `--lane` (local only), `--broadcast <id>`, `--apply`; anything else, or anything twice, is usage. */
export function parseRepairArgs(argv: string[]): ReturnType<typeof parseStageArgs> {
  return parseStageArgs(argv, { values: ['--broadcast'], flags: ['--apply'] });
}

const invokedDirectly =
  import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('repair-share-outcomes.ts');
if (invokedDirectly) {
  const parsed = parseRepairArgs(process.argv.slice(2));
  if ('usage' in parsed) {
    console.error(
      `Usage: npx tsx app/scripts/${SCRIPT_NAME}.ts --env local|dev|prod [--lane <L>] [--broadcast <id>] [--apply]\n` +
        '  DRY RUN (the census) by default; --apply writes. Unknown or repeated arguments are refused.\n' +
        '  --lane selects a hermetic e2e lane (local only); --broadcast walks one share.',
    );
    process.exit(2);
  }
  const apply = parsed.flags.has('--apply');
  const broadcastId = parsed.values.get('--broadcast');
  void (async () => {
    // STEP 1 - resolve the target on its own: a refusal here (the account
    // guard, STS, an ambient AWS_ENDPOINT_URL*) happens BEFORE any table is
    // read, so it never points the operator at a PARTIAL report.
    let stage: StageClient;
    try {
      stage = await resolveTargetForRepair(parsed.target, {}, parsed.lane !== undefined ? { lane: parsed.lane } : {});
    } catch (err) {
      defaultLogger.error({ err }, `${SCRIPT_NAME} - FAILED before the run started (no table was read or written)`);
      process.exitCode = 1;
      return;
    }
    // STEP 2 - the run.
    try {
      defaultLogger.info(
        { target: parsed.target, endpoint: stage.describe, prefix: stage.prefix, apply, ...(broadcastId !== undefined && { broadcastId }) },
        `${SCRIPT_NAME} - starting`,
      );
      const report = await runRepairShareOutcomes({
        doc: stage.doc,
        env: stage.env,
        apply,
        ...(broadcastId !== undefined && { broadcastId }),
      });
      process.exitCode = reportRepair(report, apply);
    } catch (err) {
      if (err instanceof UsageError) {
        console.error(err.message);
        process.exitCode = 2;
        return;
      }
      defaultLogger.error({ err }, `${SCRIPT_NAME} - FAILED (see the PARTIAL report above)`);
      process.exitCode = 1;
    } finally {
      stage.doc.destroy();
    }
  })();
}
