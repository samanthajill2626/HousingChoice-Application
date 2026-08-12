// Bulk migration: every imported group thread -> a native group text
// (group-texting spec section 9, convergence rules in 15.4).
//
// CONVERGENCE, NOT CONVERSION. Every run drives EVERY expected imported id to
// the FULL end state - type `group_text`, every member stamped with
// `group_participation_at`, an active Conversations rail with a verified
// participant map. "Already converted" never skips the remaining steps, because
// the failure this exists to survive is a run that died halfway: conversion
// landed, stamping or rail creation did not.
//
// THE EXPECTED-ID SET COMES FROM THE EXPORT, NEVER THE DATABASE (worklist A26).
// The obvious source - `listRelayGroups('connecting')` - structurally cannot see
// rows a previous run already converted, so a DB-sourced list would silently
// shrink to nothing on the second run and report success while leaving the
// unstamped, rail-less threads exactly as they were.
//
// PARITY BEFORE ANYTHING (spec 4.1). The runtime exclusion set and the export's
// `ownNumbers` must agree in BOTH directions, because both mismatches are
// silent: a number missing from the runtime list makes detection mint a
// DIFFERENT id for the same group (two threads, split history), and an extra one
// subtracts a real member from every roster containing them. A mismatch refuses
// the WHOLE run before a single row is touched.
//
// PII (doc 9): row records carry conversationIds and counts. The parity refusal
// carries phone numbers by design - it is an operator-facing configuration
// error that cannot be fixed without seeing which numbers differ, exactly like
// import:apply's phone-mismatch refusal.
import { normalizeToE164 } from '../phone.js';
import type { Logger } from '../logger.js';
import { logger as defaultLogger } from '../logger.js';
import type { ContactsRepo } from '../../repos/contactsRepo.js';
import type { ConversationParticipant, ConversationsRepo } from '../../repos/conversationsRepo.js';
import {
  convertConnectingRelayGroupToGroupText,
  type GroupConvertResult,
} from '../../services/groupConvert.js';
import type { GroupExclusionSet } from '../../services/groupIdentity.js';
import {
  MAX_RAIL_MEMBERS,
  RAIL_STEP_NOT_WIRED,
  type GroupRailEnsurer,
  type GroupRailRequest,
  type GroupRailResult,
} from '../../services/groupRail.js';

// ---------------------------------------------------------------------------
// The rail injection point (wired by S6's T6.6(c))
// ---------------------------------------------------------------------------

// The seam itself now lives in `services/groupRail.ts`, beside the detection
// ENQUEUE seam it is the sibling of, because the migration is no longer its only
// consumer (T5.2's send-time backstop calls the same ensurer, and a service
// reaching into the import subsystem for a rail type is the wrong direction).
// Re-exported here unchanged so every existing importer and this module's own
// contract are untouched: same names, same shapes, same not-wired default.
export {
  RAIL_STEP_NOT_WIRED,
  type GroupRailEnsurer,
  type GroupRailRequest,
  type GroupRailResult,
} from '../../services/groupRail.js';

// ---------------------------------------------------------------------------
// Parity
// ---------------------------------------------------------------------------

export interface GroupIdentityParity {
  ok: boolean;
  /** In the export's ownNumbers but NOT in the runtime exclusion list. */
  missingFromRuntime: string[];
  /** In the runtime exclusion list but NOT in the export's ownNumbers. */
  extraInRuntime: string[];
}

function normalizedSet(values: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (const raw of values) {
    const e164 = normalizeToE164(raw);
    if (e164 !== undefined) out.add(e164);
  }
  return out;
}

/**
 * Set equality between the importer's org numbers and the deployed runtime
 * exclusion list, MODULO the business number and the pool numbers (spec 4.1) -
 * those are excluded at runtime by their own mechanisms and are not expected to
 * appear in the configured list.
 */
export function checkGroupIdentityParity(
  ownNumbers: Iterable<string>,
  exclusions: GroupExclusionSet,
): GroupIdentityParity {
  const modulo = normalizedSet([
    ...(exclusions.businessPhoneNumber !== undefined ? [exclusions.businessPhoneNumber] : []),
    ...(exclusions.poolNumbers ?? []),
  ]);
  const expected = [...normalizedSet(ownNumbers)].filter((n) => !modulo.has(n));
  const configured = new Set(
    [...normalizedSet(exclusions.configuredNumbers ?? [])].filter((n) => !modulo.has(n)),
  );

  const missingFromRuntime = expected.filter((n) => !configured.has(n)).sort();
  const expectedSet = new Set(expected);
  const extraInRuntime = [...configured].filter((n) => !expectedSet.has(n)).sort();
  return {
    ok: missingFromRuntime.length === 0 && extraInRuntime.length === 0,
    missingFromRuntime,
    extraInRuntime,
  };
}

/** Refusal of the WHOLE run: thrown before any row is touched. */
export class GroupIdentityParityError extends Error {
  constructor(readonly parity: GroupIdentityParity) {
    super(
      'REFUSED: the runtime group-identity exclusion set does not match the export.\n' +
        `  in the export but NOT excluded at runtime (${parity.missingFromRuntime.length}): ` +
        `${parity.missingFromRuntime.join(', ') || '-'}\n` +
        `  excluded at runtime but NOT in the export (${parity.extraInRuntime.length}): ` +
        `${parity.extraInRuntime.join(', ') || '-'}\n` +
        'A missing number mints a DIFFERENT conversation id for the same group; an extra one ' +
        'silently subtracts a real member from every roster containing them. Nothing was converted.',
    );
    this.name = 'GroupIdentityParityError';
  }
}

/**
 * The parity gate as a single callable, so BOTH cutover commands run the SAME
 * check rather than one of them inheriting it by accident (adversarial finding
 * 6).
 *
 * It used to run only inside `runConvertGroups`, i.e. AFTER `import:apply` had
 * already written 132 group conversations and their whole history at ids derived
 * from the export's `ownNumbers`. If those numbers disagreed with the deployed
 * `GROUP_IDENTITY_EXCLUDED_NUMBERS`, apply wrote an entire orphaned population
 * and convert then refused to convert any of it - and nothing retracts group
 * threads (docs/issues/import-group-thread-retraction.md). `scripts/import-apply.ts`
 * now calls this before its first write, which closes that window at the cost of
 * one function call.
 */
export function assertGroupIdentityParity(
  ownNumbers: Iterable<string>,
  exclusions: GroupExclusionSet,
): void {
  const parity = checkGroupIdentityParity(ownNumbers, exclusions);
  if (!parity.ok) throw new GroupIdentityParityError(parity);
}

/**
 * The env vars the parity gate's RUNTIME side is built from. Both are required
 * to be DECLARED in the invocation env of a cutover command.
 */
export const GROUP_IDENTITY_ENV_VARS = [
  'GROUP_IDENTITY_EXCLUDED_NUMBERS',
  'BUSINESS_PHONE_NUMBER',
] as const;

/** The cutover command refuses to GUESS its own runtime side. */
export class GroupIdentityEnvUndeclaredError extends Error {
  constructor(readonly missing: readonly string[]) {
    super(
      'REFUSED: the group-identity parity gate has nothing to compare the export against.\n' +
        `  not set in this invocation: ${missing.join(', ')}\n\n` +
        'This is NOT a mismatch - it is a MISSING DECLARATION. The command reads its runtime side ' +
        'from the shell it is invoked in (there is no dotenv in this repo), so an unset ' +
        'GROUP_IDENTITY_EXCLUDED_NUMBERS does not mean "the org has no other numbers", it means ' +
        '"we were not told". Comparing against it would report EVERY org number in the export as ' +
        'missing from the runtime, and an unset BUSINESS_PHONE_NUMBER would name the org\'s own ' +
        'main line in the refusal.\n\n' +
        'Set BOTH in the same shell, to the values the stage you are targeting is DEPLOYED with. ' +
        'RUNBOOK -> "Native group texting: merge/cutover checklist" -> step 1 (RANK 1: push ' +
        'GROUP_IDENTITY_EXCLUDED_NUMBERS) says what the value is and where it comes from; the ' +
        'literal `none` is the way to assert the org has no other number.',
    );
    this.name = 'GroupIdentityEnvUndeclaredError';
  }
}

/**
 * THE PARITY GATE'S PRECONDITION (adversarial finding 1, BLOCKING).
 *
 * The gate compares the export's `ownNumbers` against `loadConfig()`, which
 * reads ambient `process.env` and nothing else. A RUNBOOK-documented invocation
 * sets `DYNAMODB_ENDPOINT` and `TABLE_PREFIX` and no more, so the gate compared
 * the export against an EMPTY exclusion set and refused every run - including
 * the mandatory `--dry-run` rehearsal, with no bypass flag. The instrument that
 * runs once, on cutover day, against 132 real threads could not be run at all.
 *
 * "Unset" and "declared empty" are not the same statement, so the fix is to
 * demand the declaration rather than to soften the comparison: an operator who
 * has typed `GROUP_IDENTITY_EXCLUDED_NUMBERS=none` has asserted something the
 * gate can check, and one who typed nothing has not. Note what the gate still
 * does not prove: it compares against the INVOKING shell, not against what is
 * deployed. Setting these to the deployed values is the operator's job and the
 * RUNBOOK step says so.
 */
export function assertGroupIdentityEnvDeclared(env: NodeJS.ProcessEnv): void {
  const missing = GROUP_IDENTITY_ENV_VARS.filter((name) => (env[name] ?? '').trim().length === 0);
  if (missing.length > 0) throw new GroupIdentityEnvUndeclaredError(missing);
}

/** A pool-number read that could not be completed - never a parity verdict. */
export class PoolNumbersUnavailableError extends Error {
  constructor(readonly attempts: number, readonly lastError: unknown) {
    const detail = lastError instanceof Error ? lastError.message : String(lastError);
    super(
      `REFUSED: could not read the active pool numbers after ${attempts} attempts - ${detail}\n\n` +
        'This is NOT a mismatch and NOTHING was written. Pool numbers are subtracted from BOTH ' +
        'sides of the group-identity comparison, so continuing without them would turn any pool ' +
        'number present in either list into a FALSE parity refusal on cutover day. Check the ' +
        'DYNAMODB_ENDPOINT / TABLE_PREFIX this command is pointed at and the credentials for it, ' +
        'then re-run.',
    );
    this.name = 'PoolNumbersUnavailableError';
  }
}

/**
 * Read the active pool numbers for the parity comparison, with retries
 * (adversarial finding 22).
 *
 * This used to swallow the failure and compare with `poolNumbers = []`, which
 * is fail-safe in direction but is a new single point of REFUSAL on cutover day
 * - one throttle and the run (and the rehearsal dry run) stops with a message
 * about numbers that are perfectly fine. A transient failure is retried; a
 * persistent one aborts under its own name so the operator is never sent to
 * debug the exclusion list for a problem that is a table read.
 */
export async function readPoolNumbersForParity(
  listActive: () => Promise<readonly { poolNumber: string }[]>,
  opts: {
    attempts?: number;
    delaysMs?: readonly number[];
    sleep?: (ms: number) => Promise<void>;
    onRetry?: (attempt: number, err: unknown) => void;
  } = {},
): Promise<string[]> {
  const attempts = opts.attempts ?? 3;
  const delays = opts.delaysMs ?? [250, 750];
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return (await listActive()).map((p) => p.poolNumber);
    } catch (err) {
      lastError = err;
      if (attempt < attempts) {
        opts.onRetry?.(attempt, err);
        await sleep(delays[attempt - 1] ?? delays[delays.length - 1] ?? 250);
      }
    }
  }
  throw new PoolNumbersUnavailableError(attempts, lastError);
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

/** One imported group the export says must exist, converted or not. */
export interface ExpectedGroup {
  conversationId: string;
  /** The workbook row key (`GRP-0007`), for the operator report. */
  rowKey?: string;
}

export interface ConvertGroupsOptions {
  conversationsRepo: ConversationsRepo;
  contactsRepo: ContactsRepo;
  /** Re-derived FROM THE EXPORT (A26), never from a DB query. */
  expected: readonly ExpectedGroup[];
  /** The export's org numbers - the same context the expected ids came from. */
  ownNumbers: Iterable<string>;
  /** The runtime exclusion set as this stack has it deployed. */
  exclusions: GroupExclusionSet;
  /** Defaults to RAIL_STEP_NOT_WIRED. */
  rail?: GroupRailEnsurer;
  /** ONE instant for the whole migration, so it reads as a single event. */
  at?: string;
  logger?: Logger;
  onProgress?: (done: number, total: number) => void;
}

export interface GroupConversionRow {
  conversationId: string;
  rowKey?: string;
  outcome: GroupConvertResult['outcome'];
  refusedReason?: string;
  importConnectRequested: boolean;
  contactIdsBackfilled: number;
  /** Roster entries this run gave a `name` (see GroupConvertResult). */
  namesBackfilled: number;
  membersStamped: number;
  membersAlreadyStamped: number;
  /** Roster slots whose vanished contact record this run RE-MINTED as a stub. */
  membersReminted: number;
  /** contactIds on the roster with no contact record behind them. */
  membersMissing: string[];
  rail: GroupRailResult['status'];
  railSid?: string;
  railReason?: string;
  /**
   * STRUCTURALLY UNRAILABLE, and therefore a HUMAN DECISION (adversarial
   * finding 15). A roster that is empty or larger than a rail can hold cannot
   * be railed by any retry, and the detection path deliberately stops
   * re-enqueuing such a thread - so nothing anywhere writes a state that says
   * "this thread is permanently inbound-only". This report is that reader.
   */
  railAdjudication?: 'empty_roster' | 'roster_too_large';
}

export interface GroupConversionReport {
  rows: GroupConversionRow[];
  /**
   * THE REPORT'S ARITHMETIC CLOSES, in two lines the operator can check by eye:
   *   expected  = processed + duplicateIds
   *   processed = converted + alreadyConverted + refused
   * A gate whose totals do not tie out is not a gate, and `expected` counts the
   * ids the EXPORT says must exist while every other total counts the rows we
   * actually walked - the two differ exactly by the `seen` dedupe.
   */
  totals: {
    expected: number;
    /** Rows actually walked - `expected` minus the duplicate ids. */
    processed: number;
    /** Expected entries skipped because the same id appeared earlier. */
    duplicateIds: number;
    converted: number;
    alreadyConverted: number;
    refused: number;
    connectRequested: number;
    contactIdsBackfilled: number;
    namesBackfilled: number;
    membersStamped: number;
    membersReminted: number;
    membersMissing: number;
    railsCreated: number;
    railsExisting: number;
    railsFailed: number;
    railsUnavailable: number;
    /** Rows a human must adjudicate: the roster can never carry a rail. */
    railAdjudicationRequired: number;
  };
  warnings: string[];
  /**
   * The HARDENED CUTOVER INVARIANT (spec 14): every expected id reached the full
   * end state on this run. False while ANY row is refused, or has no rail.
   */
  complete: boolean;
}

export async function runConvertGroups(
  options: ConvertGroupsOptions,
): Promise<GroupConversionReport> {
  const { conversationsRepo, contactsRepo, expected } = options;
  const log = options.logger ?? defaultLogger;
  const rail = options.rail ?? RAIL_STEP_NOT_WIRED;
  const at = options.at ?? new Date().toISOString();

  // BEFORE ANYTHING. A mismatch here means every id we are about to converge may
  // be the wrong id. Same call `scripts/import-apply.ts` makes before ITS first
  // write - one gate, two commands.
  assertGroupIdentityParity(options.ownNumbers, options.exclusions);

  const warnings: string[] = [];
  const rows: GroupConversionRow[] = [];
  const seen = new Set<string>();

  let done = 0;
  for (const group of expected) {
    options.onProgress?.(++done, expected.length);
    if (seen.has(group.conversationId)) continue;
    seen.add(group.conversationId);

    // PER-ROW ISOLATION, the same posture the rail step below has (and for the
    // same reason). Every repo call inside the conversion is unguarded, so one
    // DynamoDB throttle or 5xx anywhere in the 132 x (1 + N members) calls used
    // to throw out of this loop, past the script's parity-only catch, and the
    // operator got a stack trace INSTEAD OF THE REPORT - on a step that runs
    // once, on cutover day, against 132 real threads. The run is convergent so
    // a re-run heals the data; what a re-run cannot recover is the record of
    // which rows converted, which were refused, and why. THE REPORT IS THE
    // CUTOVER GATE (spec 14), so it must survive any single row.
    const converted = await convertRow(group.conversationId, {
      conversationsRepo,
      contactsRepo,
      at,
      logger: log,
    });

    const row: GroupConversionRow = {
      conversationId: group.conversationId,
      ...(group.rowKey !== undefined && { rowKey: group.rowKey }),
      outcome: converted.outcome,
      ...(converted.refusedReason !== undefined && { refusedReason: converted.refusedReason }),
      importConnectRequested: converted.importConnectRequested,
      contactIdsBackfilled: converted.contactIdsBackfilled,
      namesBackfilled: converted.namesBackfilled,
      membersStamped: converted.membersStamped,
      membersAlreadyStamped: converted.membersAlreadyStamped,
      membersReminted: converted.membersReminted,
      membersMissing: converted.membersMissing,
      // A refused row has no thread to rail; anything else gets the step on
      // EVERY run, converted-this-time or not.
      rail: 'unavailable',
    };

    if (converted.outcome === 'refused') {
      warnings.push(
        `${group.rowKey ?? group.conversationId}: ${converted.refusedReason ?? 'refused'}`,
      );
      row.railReason = 'not attempted - the thread was not converted';
    } else {
      // STRUCTURAL UNRAILABILITY IS DECIDED FROM THE ROSTER, not from the rail
      // step's reason string (adversarial finding 15). An empty or over-cap
      // roster refuses forever: `ensureGroupRail` returns `failed` without
      // spending a Twilio call, the webhook's re-enqueue deliberately skips it,
      // and NOTHING stamps `rail_failed` for these two cases - so a thread that
      // is permanently inbound-only is indistinguishable in stored state from a
      // healthy one. The cutover gate (spec 14) allows such a thread only as an
      // explicitly adjudicated inbound-only thread, so the report has to hand
      // the operator the list rather than let it hide among transient failures.
      const rosterSize = converted.members.length;
      if (rosterSize === 0) row.railAdjudication = 'empty_roster';
      else if (rosterSize > MAX_RAIL_MEMBERS) row.railAdjudication = 'roster_too_large';

      const outcome = await ensureRail(rail, {
        conversationId: group.conversationId,
        members: converted.members,
      });
      row.rail = outcome.status;
      if (outcome.twilioConversationSid !== undefined) {
        row.railSid = outcome.twilioConversationSid;
      }
      if (outcome.reason !== undefined) row.railReason = outcome.reason;
      if (outcome.status === 'failed' && row.railAdjudication === undefined) {
        warnings.push(
          `${group.rowKey ?? group.conversationId}: converted, but its group text rail FAILED - ` +
            `${outcome.reason ?? 'no reason given'}. The thread cannot send until this is fixed.`,
        );
      }
      if (row.railAdjudication !== undefined) {
        warnings.push(
          `${group.rowKey ?? group.conversationId}: ADJUDICATION REQUIRED - ` +
            (row.railAdjudication === 'empty_roster'
              ? 'the roster is EMPTY, so a rail would reach nobody'
              : `the roster of ${rosterSize} members exceeds the ${MAX_RAIL_MEMBERS} a rail can ` +
                'hold') +
            '. No re-run can fix this and nothing re-enqueues it: the thread is permanently ' +
            'INBOUND-ONLY until a human fixes the roster or records it as a known inbound-only ' +
            'thread. It is counted here because no stored field says so.',
        );
      }
    }

    if (converted.membersReminted > 0) {
      // Said out loud because it is a DATA CREATION the operator did not ask for
      // by hand: a workbook `drop` on a group member removes the contact record
      // but never the roster slot, and a slot with no row behind it refuses
      // EVERY outbound send on that thread forever (groupSend's consent fence is
      // a whole-send refusal). The drop still stands for 1:1 and history
      // purposes; what comes back is a group-scoped stub with NO consent method.
      warnings.push(
        `${group.rowKey ?? group.conversationId}: ${converted.membersReminted} roster member(s) ` +
          `had NO contact record and were RE-MINTED as group-scoped stubs (origin ` +
          `group_detection, group_participation_at only - no SMS consent). A workbook \`drop\` on ` +
          `a group member is the known producer; the drop still holds for their 1:1 records. ` +
          `That drop is now PERMANENTLY INOPERATIVE for those people: the stub carries the ` +
          `group_detection origin, which every later import:apply refuses to retract.`,
      );
    }
    if (converted.membersMissing.length > 0) {
      warnings.push(
        `${group.rowKey ?? group.conversationId}: ${converted.membersMissing.length} roster ` +
          `member(s) have no contact record and could NOT be re-minted - the thread cannot send ` +
          `until they exist (every group send refuses on a member with no consent basis).`,
      );
    }
    rows.push(row);
  }

  const totals = {
    // The number of ids the EXPORT says must exist, never the number of rows we
    // got round to processing. `rows.length` shrinks silently when `seen`
    // dedupes, and it would equal itself on a run that derived nothing - so the
    // two counts below make the difference explicit rather than leaving the
    // operator to reconcile `expected` against outcome totals that cannot sum
    // to it (`expected = processed + duplicateIds`).
    expected: expected.length,
    processed: rows.length,
    duplicateIds: expected.length - rows.length,
    converted: rows.filter((r) => r.outcome === 'converted').length,
    alreadyConverted: rows.filter((r) => r.outcome === 'already_converted').length,
    refused: rows.filter((r) => r.outcome === 'refused').length,
    connectRequested: rows.filter((r) => r.importConnectRequested).length,
    contactIdsBackfilled: rows.reduce((n, r) => n + r.contactIdsBackfilled, 0),
    namesBackfilled: rows.reduce((n, r) => n + r.namesBackfilled, 0),
    membersStamped: rows.reduce((n, r) => n + r.membersStamped, 0),
    membersReminted: rows.reduce((n, r) => n + r.membersReminted, 0),
    membersMissing: rows.reduce((n, r) => n + r.membersMissing.length, 0),
    railsCreated: rows.filter((r) => r.rail === 'created').length,
    railsExisting: rows.filter((r) => r.rail === 'existing').length,
    railsFailed: rows.filter((r) => r.rail === 'failed').length,
    railsUnavailable: rows.filter((r) => r.rail === 'unavailable').length,
    railAdjudicationRequired: rows.filter((r) => r.railAdjudication !== undefined).length,
  };

  // An EMPTY expected set is not a complete migration - it is a run that
  // derived no ids at all, which on cutover day means the export was read
  // wrong. Reporting "COMPLETE: every expected group thread is a native group
  // text with a rail" for zero threads is the worst possible answer.
  //
  // `membersMissing` IS A TERM (adversarial finding 2). It was summed and warned
  // about but never gated, so a roster slot pointing at a contact row that does
  // not exist reported COMPLETE - while `groupSend`'s consent fence refused
  // EVERY outbound on that thread forever and nothing self-heals it
  // (`resolveGroupMembers` has one caller, the thread-CREATE branch). Conversion
  // now re-mints such a slot, so a residual `membersMissing` means the re-mint
  // ITSELF failed: a thread that can receive and can never reply is not a
  // migrated thread, and the cutover gate must say so.
  //
  // `membersReminted` IS ALSO A TERM (adversarial finding 34). A re-mint is
  // CONTACT CREATION the operator did not ask for by hand, on the run that is
  // the cutover gate, and it makes the founder's `drop` permanently inoperative
  // for that person - a COMPLETE stamped over N of those is the report signing
  // off on a decision nobody made. The run is convergent, so the operator reads
  // the warnings and runs it again: the second pass re-mints nothing (the stubs
  // exist) and reports COMPLETE. The cost of the term is one extra run; the
  // cost of omitting it is a silent product decision.
  const complete =
    rows.length > 0 &&
    totals.refused === 0 &&
    totals.membersMissing === 0 &&
    totals.membersReminted === 0 &&
    totals.railsFailed === 0 &&
    totals.railsUnavailable === 0;
  if (rows.length === 0) {
    warnings.push(
      'the expected-id set was EMPTY - nothing was converted. Check the export the ids were derived from.',
    );
  }
  if (totals.duplicateIds > 0) {
    // Said out loud rather than left as a silent gap between `expected` and the
    // outcome totals: the same conversationId listed twice means two workbook
    // group rows derived one thread, which is a question about the export.
    warnings.push(
      `${totals.duplicateIds} expected id(s) appeared more than once and were converged ONCE - ` +
        `${totals.processed} of ${totals.expected} entries were processed. Two workbook rows ` +
        'deriving the same conversation id means the same carrier group is listed twice.',
    );
  }
  log.info({ ...totals, complete }, 'group text migration run finished');
  return { rows, totals, warnings, complete };
}

/**
 * A conversion that THROWS is a REFUSED ROW, never a failed run. The refusal
 * carries the error text so the report says what actually broke, and the row is
 * still counted - `complete` is false while any row is refused, so a run that
 * hit a throttle can never report the cutover invariant as satisfied.
 */
async function convertRow(
  conversationId: string,
  opts: Parameters<typeof convertConnectingRelayGroupToGroupText>[1],
): Promise<GroupConvertResult> {
  try {
    return await convertConnectingRelayGroupToGroupText(conversationId, opts);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      conversationId,
      outcome: 'refused',
      refusal: 'threw',
      refusedReason: `${conversationId} was NOT converted: the conversion threw - ${detail}.`,
      importConnectRequested: false,
      contactIdsBackfilled: 0,
      namesBackfilled: 0,
      membersStamped: 0,
      membersAlreadyStamped: 0,
      membersReminted: 0,
      membersMissing: [],
      members: [],
    };
  }
}

/**
 * A rail ensurer that throws is a FAILED ROW, never a failed run: one bad
 * thread must not stop the other 131 from converging.
 */
async function ensureRail(
  rail: GroupRailEnsurer,
  request: GroupRailRequest,
): Promise<GroupRailResult> {
  try {
    return await rail.ensureGroupRail(request);
  } catch (err) {
    return { status: 'failed', reason: err instanceof Error ? err.message : String(err) };
  }
}
