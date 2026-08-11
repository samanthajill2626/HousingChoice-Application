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
  /** contactIds on the roster with no contact record behind them. */
  membersMissing: string[];
  rail: GroupRailResult['status'];
  railSid?: string;
  railReason?: string;
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
    membersMissing: number;
    railsCreated: number;
    railsExisting: number;
    railsFailed: number;
    railsUnavailable: number;
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
  // be the wrong id.
  const parity = checkGroupIdentityParity(options.ownNumbers, options.exclusions);
  if (!parity.ok) throw new GroupIdentityParityError(parity);

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
      const outcome = await ensureRail(rail, {
        conversationId: group.conversationId,
        members: converted.members,
      });
      row.rail = outcome.status;
      if (outcome.twilioConversationSid !== undefined) {
        row.railSid = outcome.twilioConversationSid;
      }
      if (outcome.reason !== undefined) row.railReason = outcome.reason;
      if (outcome.status === 'failed') {
        warnings.push(
          `${group.rowKey ?? group.conversationId}: converted, but its group text rail FAILED - ` +
            `${outcome.reason ?? 'no reason given'}. The thread cannot send until this is fixed.`,
        );
      }
    }

    if (converted.membersMissing.length > 0) {
      warnings.push(
        `${group.rowKey ?? group.conversationId}: ${converted.membersMissing.length} roster ` +
          `member(s) have no contact record - their chips will render from the phone alone.`,
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
    membersMissing: rows.reduce((n, r) => n + r.membersMissing.length, 0),
    railsCreated: rows.filter((r) => r.rail === 'created').length,
    railsExisting: rows.filter((r) => r.rail === 'existing').length,
    railsFailed: rows.filter((r) => r.rail === 'failed').length,
    railsUnavailable: rows.filter((r) => r.rail === 'unavailable').length,
  };

  // An EMPTY expected set is not a complete migration - it is a run that
  // derived no ids at all, which on cutover day means the export was read
  // wrong. Reporting "COMPLETE: every expected group thread is a native group
  // text with a rail" for zero threads is the worst possible answer.
  const complete =
    rows.length > 0 &&
    totals.refused === 0 &&
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
