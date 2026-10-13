// assign-primary-contacts - the ONE-TIME repair of the properties whose
// primary contact is missing or deleted (spec
// docs/superpowers/specs/2026-10-12-primary-contact-integrity-design.md,
// section 8; plan constraint C12). From this branch on, every write keeps the
// primary pointing at a usable person (spec section 4); this pass repairs the
// properties already in the broken state - 470 Bolton's shape: no primary
// contact, no landlord of record, one live contact added as Property Manager.
//
// READS every unit (live AND soft-deleted) with a consistent Scan
// (unitsRepo.list, deleted 'any', consistentRead), and per unit ONE complete
// batch read of the contacts its contact list and landlord of record name
// (readRosterContacts: requireComplete; ANY throw = liveness unknown, never
// "deleted" - spec 4.2).
//
// PER UNIT (planUnitPrimary, pure):
//   - TARGET: its flagged primary (unitContacts()) is absent or not live AND
//     the heir function (chooseHeir, nothing excluded) names an heir. The
//     write flags exactly the heir (adding the landlord's row when the heir is
//     an off-roster landlord of record - applyPrimary) and sets the
//     primary_contact scalar to it; then ONE unit_primary_contact_assigned
//     audit event { contactId, reason: 'backfill', from? } with no actor
//     (from = the flagged contact it replaces, when there was one).
//   - ALIGN (counted scalarAligned): its flagged primary is live and stored,
//     but the scalar is absent or names someone else. The write sets the
//     scalar (the contact list goes back unchanged); no audit event - the
//     primary did not change. A landlord-only unit (no stored contact list:
//     its primary is the DERIVED landlord row) is left alone.
//   - COUNTED, never written: noHeir (no live contact and no live landlord of
//     record), noEligible (live contacts, none eligible for automatic routing
//     - only a tenant or a caseworker; listed by unit id so Sam can choose on
//     the property page), unknown (the contact read failed - re-run),
//     unchanged (nothing to do).
//
// NO LOCK (spec section 8): every write is unitsRepo.assignPrimaryIfCurrent,
// conditional on the contact list AND landlordId THIS run read - never
// addContact, which re-reads and would overwrite a primary set meanwhile. A
// unit changed since the read is counted skippedOnCondition and left for a
// re-run. Idempotent: a completed apply plans nothing on a re-run.
//
// TARGET: --env local|dev|prod through scripts/lib/stageClient.ts (dev/prod:
// account guard first, client bound to the housingchoice profile). An agent
// runs this ONLY with --env local --lane <L> against a hermetic e2e lane it
// started. NO AGENT RUNS THIS AGAINST A REAL ENVIRONMENT; the human does, per
// the RUNBOOK, after that environment's deploy.
//
//   npx tsx app/scripts/assign-primary-contacts.ts --env dev
//   npx tsx app/scripts/assign-primary-contacts.ts --env dev --apply
//
// Exit codes: 0 the run completed (units skipped on their condition included
// - re-run for them); 1 it completed with failures (a unit whose contact read
// failed, or a write that failed), aborted (the Scan failed: a PARTIAL
// report), or the target could not be resolved (nothing read); 2 usage.
//
// PII: prints and logs counts, unit ids and contact ids only - never a
// person's name, a phone or a street.
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { logger as defaultLogger, type Logger } from '../src/lib/logger.js';
import {
  applyPrimary,
  chooseHeir,
  readRosterContacts,
  rosterContactIds,
  type RosterContactsRead,
} from '../src/lib/propertyContact.js';
import { createAuditRepo, type AuditRepo } from '../src/repos/auditRepo.js';
import { createContactsRepo, isDeleted as isContactDeleted, type ContactsRepo } from '../src/repos/contactsRepo.js';
import {
  createUnitsRepo,
  isDeleted as isUnitDeleted,
  unitContacts,
  type UnitContact,
  type UnitItem,
  type UnitsRepo,
} from '../src/repos/unitsRepo.js';
import {
  parseStageArgs,
  resolveStageClient,
  type StageClient,
  type StageClientOpts,
  type StageTarget,
} from './lib/stageClient.js';

// ---------------------------------------------------------------------------
// Planning (pure): what one unit needs
// ---------------------------------------------------------------------------

export const SCRIPT_NAME = 'assign-primary-contacts';

/** The audit event each primary assignment appends (plan contract 2.4). */
export const PRIMARY_ASSIGNED_EVENT = 'unit_primary_contact_assigned';

/** One unit's conditional write: its whole contact list and the scalar. */
export interface PrimaryWrite {
  contacts: UnitContact[];
  primaryContact: string;
}

/**
 * What one unit needs (spec section 8). `target`: its primary is absent or
 * not live and the heir function named an heir (`from` = the flagged contact
 * it replaces, when there was one). `align`: its live, stored primary does
 * not match the scalar. The rest are counted only.
 */
export type UnitPrimaryPlan =
  | { kind: 'target'; heirId: string; from?: string; write: PrimaryWrite }
  | { kind: 'align'; write: PrimaryWrite }
  | { kind: 'noHeir' }
  | { kind: 'noEligible' }
  | { kind: 'unknown' }
  | { kind: 'unchanged' };

/** The landlord of record as the repos read it: a non-empty string, else none. */
function landlordOf(unit: Pick<UnitItem, 'landlordId'>): string | undefined {
  return typeof unit.landlordId === 'string' && unit.landlordId.length > 0 ? unit.landlordId : undefined;
}

/** Live (spec section 3): the complete read returned the contact and it is not soft-deleted. */
function isLive(read: Extract<RosterContactsRead, { ok: true }>, contactId: string): boolean {
  const contact = read.byId.get(contactId);
  return contact !== undefined && !isContactDeleted(contact);
}

/**
 * ONE unit's plan, from the unit as the Scan read it and the complete contact
 * read of its contact list + landlord of record. WHO takes over is never
 * decided here: chooseHeir answers it (nothing excluded - this run deleted
 * nobody) and applyPrimary builds the contact list - the same two functions
 * every app write uses (spec 4.3).
 */
export function planUnitPrimary(unit: UnitItem, read: RosterContactsRead): UnitPrimaryPlan {
  // A failed read decides nothing, and is never read as "deleted" (spec 4.2).
  if (!read.ok) return { kind: 'unknown' };
  const roster = unitContacts(unit);
  const flagged = roster.find((row) => row.primaryContact === true);
  if (flagged !== undefined && isLive(read, flagged.contactId)) {
    // A live primary stays. Only the scalar may need aligning - and only on a
    // STORED contact list: a landlord-only unit's primary is the derived
    // landlord row, which has no stored scalar to agree with (spec section 8).
    const stored = Array.isArray(unit.contacts) && unit.contacts.length > 0;
    if (stored && unit.primary_contact !== flagged.contactId) {
      return {
        kind: 'align',
        write: { contacts: roster.map((row) => ({ ...row })), primaryContact: flagged.contactId },
      };
    }
    return { kind: 'unchanged' };
  }
  const heir = chooseHeir({ roster, landlordId: landlordOf(unit), read });
  if (heir.kind === 'unknown') return { kind: 'unknown' };
  if (heir.kind === 'none') return { kind: heir.why === 'no_eligible_candidate' ? 'noEligible' : 'noHeir' };
  const applied = applyPrimary(roster, { contactId: heir.contactId, addLandlordRow: heir.addLandlordRow });
  return {
    kind: 'target',
    heirId: heir.contactId,
    ...(flagged !== undefined && { from: flagged.contactId }),
    write: { contacts: applied.contacts, primaryContact: heir.contactId },
  };
}

// ---------------------------------------------------------------------------
// The run (dry run by default; --apply writes, unit by unit)
// ---------------------------------------------------------------------------

/** What the run reads and writes through. */
export interface AssignDeps {
  units: Pick<UnitsRepo, 'list' | 'assignPrimaryIfCurrent'>;
  contacts: Pick<ContactsRepo, 'getManyByIds'>;
  audit: Pick<AuditRepo, 'append'>;
}

/** The real deps, every repo on the stage's doc client and env - never the ambient TABLE_PREFIX. */
export function buildAssignDeps(
  stage: { doc: DynamoDBDocumentClient; env: NodeJS.ProcessEnv },
  logger: Logger,
): AssignDeps {
  const { doc, env } = stage;
  return {
    units: createUnitsRepo({ doc, env, logger }),
    contacts: createContactsRepo({ doc, env, logger }),
    audit: createAuditRepo({ doc, env, logger }),
  };
}

export interface AssignOptions {
  /** Write. false = dry run (the CLI's default). */
  apply: boolean;
  logger?: Logger;
  /** Test seam: the Scan page size (unset = DynamoDB's own page). */
  scanLimit?: number;
}

/**
 * The counts (spec section 8) and the unit ids behind them. `targets` and the
 * id lists are what the run PLANNED (both modes); `assigned` is what an apply
 * wrote; `scalarAligned` is what a dry run would align and an apply aligned.
 */
export interface AssignResult {
  unitsScanned: number;
  /** Soft-deleted units among them - read and repaired like live ones. */
  deletedUnits: number;
  /** Units whose primary is absent or not live AND that have an heir. */
  targets: number;
  targetsOnDeletedUnits: number;
  /** Apply only: primaries written. */
  assigned: number;
  /** Units whose live, stored primary the scalar did not match. */
  scalarAligned: number;
  /** Apply only: writes whose condition failed - the unit changed after the read; nothing written. Re-run. */
  skippedOnCondition: number;
  /** Apply only: writes that failed otherwise - they may or may not have landed. */
  writeFailed: number;
  /** No live contact and no live landlord of record: nothing anyone can do. */
  noHeir: number;
  /** Live contacts, none eligible for automatic routing: Sam chooses on the property page. */
  noEligible: number;
  /** The contact read failed: liveness unknown, nothing decided. Re-run. */
  unknown: number;
  /** Nothing to do. */
  unchanged: number;
  /** Apply only: audit events that may not have been written AFTER their primary write landed. Expected 0. */
  auditFailed: number;
  targetUnitIds: string[];
  alignedUnitIds: string[];
  noEligibleUnitIds: string[];
  unknownUnitIds: string[];
  skippedUnitIds: string[];
  failedUnitIds: string[];
}

function emptyResult(): AssignResult {
  return {
    unitsScanned: 0,
    deletedUnits: 0,
    targets: 0,
    targetsOnDeletedUnits: 0,
    assigned: 0,
    scalarAligned: 0,
    skippedOnCondition: 0,
    writeFailed: 0,
    noHeir: 0,
    noEligible: 0,
    unknown: 0,
    unchanged: 0,
    auditFailed: 0,
    targetUnitIds: [],
    alignedUnitIds: [],
    noEligibleUnitIds: [],
    unknownUnitIds: [],
    skippedUnitIds: [],
    failedUnitIds: [],
  };
}

/** The counters as one flat record: every summary log line, the PARTIAL one included. */
function flatCounts(result: AssignResult): Record<string, number> {
  return {
    unitsScanned: result.unitsScanned,
    deletedUnits: result.deletedUnits,
    targets: result.targets,
    targetsOnDeletedUnits: result.targetsOnDeletedUnits,
    assigned: result.assigned,
    scalarAligned: result.scalarAligned,
    skippedOnCondition: result.skippedOnCondition,
    writeFailed: result.writeFailed,
    noHeir: result.noHeir,
    noEligible: result.noEligible,
    unknown: result.unknown,
    unchanged: result.unchanged,
    auditFailed: result.auditFailed,
  };
}

/**
 * The run. A Scan failure ABORTS: a PARTIAL report (the counters so far) is
 * logged and the error rethrown - every write is conditional, so re-running
 * after the fix is safe. Everything else is per unit and never aborts.
 */
export async function assignPrimaryContacts(deps: AssignDeps, opts: AssignOptions): Promise<AssignResult> {
  const log = opts.logger ?? defaultLogger;
  const result = emptyResult();
  try {
    let exclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const page = await deps.units.list({
        deleted: 'any',
        consistentRead: true,
        ...(opts.scanLimit !== undefined && { limit: opts.scanLimit }),
        ...(exclusiveStartKey !== undefined && { exclusiveStartKey }),
      });
      for (const unit of page.items) await handleUnit(deps, opts.apply, result, log, unit);
      exclusiveStartKey = page.lastEvaluatedKey;
    } while (exclusiveStartKey !== undefined);
  } catch (err) {
    log.error(
      { err, ...flatCounts(result), apply: opts.apply },
      `${SCRIPT_NAME} - PARTIAL result: the run ABORTED and these counters cover only what completed before the failure. Every write is conditional, so re-running after the fix is safe.`,
    );
    throw err;
  }
  return result;
}

async function handleUnit(
  deps: AssignDeps,
  apply: boolean,
  result: AssignResult,
  log: Logger,
  unit: UnitItem,
): Promise<void> {
  const unitId = unit.unitId;
  const deleted = isUnitDeleted(unit);
  result.unitsScanned += 1;
  if (deleted) result.deletedUnits += 1;
  const read = await readRosterContacts(deps.contacts, rosterContactIds(unit), log);
  const plan = planUnitPrimary(unit, read);
  switch (plan.kind) {
    case 'unchanged':
      result.unchanged += 1;
      return;
    case 'noHeir':
      result.noHeir += 1;
      log.info({ unitId, deleted }, `${SCRIPT_NAME} - no heir: no live contact and no live landlord of record`);
      return;
    case 'noEligible':
      result.noEligible += 1;
      result.noEligibleUnitIds.push(unitId);
      log.info(
        { unitId, deleted },
        `${SCRIPT_NAME} - no eligible contact: only a tenant or a caseworker is live (choose one on the property page)`,
      );
      return;
    case 'unknown':
      result.unknown += 1;
      result.unknownUnitIds.push(unitId);
      log.warn(
        { unitId, deleted },
        `${SCRIPT_NAME} - a contact read failed: liveness unknown, nothing decided or written for this unit (re-run)`,
      );
      return;
    case 'align': {
      result.alignedUnitIds.push(unitId);
      if (!apply) {
        result.scalarAligned += 1;
        log.info({ unitId, deleted }, `${SCRIPT_NAME} - DRY RUN: would align primary_contact with the flagged primary`);
        return;
      }
      if ((await writeUnit(deps, result, log, unit, plan.write)) === 'written') {
        result.scalarAligned += 1;
        log.info({ unitId, deleted }, `${SCRIPT_NAME} - primary_contact aligned with the flagged primary`);
      }
      return;
    }
    case 'target': {
      result.targets += 1;
      if (deleted) result.targetsOnDeletedUnits += 1;
      result.targetUnitIds.push(unitId);
      const ids = { unitId, deleted, contactId: plan.heirId, ...(plan.from !== undefined && { from: plan.from }) };
      if (!apply) {
        log.info(ids, `${SCRIPT_NAME} - DRY RUN: would make this contact the primary contact`);
        return;
      }
      if ((await writeUnit(deps, result, log, unit, plan.write)) !== 'written') return;
      result.assigned += 1;
      try {
        await deps.audit.append(`units#${unitId}`, PRIMARY_ASSIGNED_EVENT, {
          contactId: plan.heirId,
          reason: 'backfill',
          ...(plan.from !== undefined && { from: plan.from }),
        });
      } catch (err) {
        // An append can land and then error (a timeout): MAY not have been written.
        result.auditFailed += 1;
        log.warn(
          { err, unitId },
          `${SCRIPT_NAME} - the audit event may not have been written (the primary was assigned); counted in auditFailed, continuing`,
        );
      }
      log.info(ids, `${SCRIPT_NAME} - primary contact assigned`);
      return;
    }
  }
}

/** ONE conditional write; a lost condition is skipped, any other failure counted - the run goes on. */
async function writeUnit(
  deps: AssignDeps,
  result: AssignResult,
  log: Logger,
  unit: UnitItem,
  write: PrimaryWrite,
): Promise<'written' | 'skipped' | 'failed'> {
  let outcome: 'written' | 'skipped';
  try {
    outcome = await deps.units.assignPrimaryIfCurrent(unit, write);
  } catch (err) {
    result.writeFailed += 1;
    result.failedUnitIds.push(unit.unitId);
    log.error(
      { err, unitId: unit.unitId },
      `${SCRIPT_NAME} - the write FAILED; it may or may not have landed - re-run the dry run to see`,
    );
    return 'failed';
  }
  if (outcome === 'skipped') {
    result.skippedOnCondition += 1;
    result.skippedUnitIds.push(unit.unitId);
    log.info(
      { unitId: unit.unitId },
      `${SCRIPT_NAME} - the unit changed after the run read it; skipped, nothing written (re-run)`,
    );
  }
  return outcome;
}

/** The end-of-run log line and the exit code it earns: 1 when a unit could not be decided or a write failed. */
export function reportAssignRun(result: AssignResult, apply: boolean, log: Logger = defaultLogger): 0 | 1 {
  const suffix = apply ? '' : ' (DRY RUN - nothing written)';
  const fields = { ...flatCounts(result), apply };
  if (result.unknown > 0 || result.writeFailed > 0) {
    log.warn(
      fields,
      `${SCRIPT_NAME} - COMPLETED WITH FAILURES${suffix}: ${result.unknown} unit(s) could not be decided (a contact read failed) and ${result.writeFailed} write(s) failed - see the WARN and ERROR lines naming them, then re-run (idempotent).`,
    );
    return 1;
  }
  if (result.skippedOnCondition > 0 || result.auditFailed > 0) {
    log.warn(
      fields,
      `${SCRIPT_NAME} - done${suffix}: ${result.skippedOnCondition} unit(s) changed while the run worked (re-run to finish them) and ${result.auditFailed} audit event(s) may not have been written`,
    );
    return 0;
  }
  log.info(fields, `${SCRIPT_NAME} - done${suffix}`);
  return 0;
}

/**
 * What the CLI prints (spec section 8): the counts, then the unit ids of each
 * list - never a name, a phone or a street.
 */
export function formatAssignSummary(result: AssignResult, apply: boolean): string[] {
  const ids = (list: readonly string[]): string => (list.length === 0 ? 'none' : list.join(', '));
  const lines = [
    apply ? 'Primary contacts - APPLIED:' : 'Primary contacts - DRY RUN, nothing written:',
    `  Properties scanned: ${result.unitsScanned} (${result.deletedUnits} soft-deleted)`,
    `  ${apply ? 'Planned a primary contact' : 'Would get a primary contact'}: ${result.targets} (${result.targetsOnDeletedUnits} on soft-deleted properties)`,
  ];
  if (apply) lines.push(`  Primary contacts assigned: ${result.assigned}`);
  lines.push(
    `  primary_contact field ${apply ? 'aligned' : 'would be aligned'} with the flagged primary: ${result.scalarAligned}`,
    `  No heir - no live contact and no live landlord of record (nothing to do): ${result.noHeir}`,
    `  No eligible contact - only a tenant or a caseworker is live (choose one on the property page): ${result.noEligible}`,
    `  Unknown - a contact read failed (re-run): ${result.unknown}`,
    `  Already fine: ${result.unchanged}`,
  );
  if (apply) {
    lines.push(
      `  Skipped - the property changed after the run read it (re-run): ${result.skippedOnCondition}`,
      `  Writes that FAILED (re-run the dry run to see): ${result.writeFailed}`,
      `  Audit events that may not have been written: ${result.auditFailed} (expected 0)`,
    );
  }
  lines.push(
    `${apply ? 'Properties planned for a primary contact' : 'Properties that would get a primary contact'}: ${ids(result.targetUnitIds)}`,
    `${apply ? 'Properties planned for a primary_contact field alignment' : 'Properties whose primary_contact field would be aligned'}: ${ids(result.alignedUnitIds)}`,
    `Properties with no eligible contact (open each one and choose a primary contact): ${ids(result.noEligibleUnitIds)}`,
    `Properties that could not be decided (re-run): ${ids(result.unknownUnitIds)}`,
  );
  if (apply) {
    lines.push(
      `Properties skipped because they changed (re-run): ${ids(result.skippedUnitIds)}`,
      `Properties whose write failed: ${ids(result.failedUnitIds)}`,
    );
  }
  return lines;
}

// ---------------------------------------------------------------------------
// The CLI
// ---------------------------------------------------------------------------

/** The argument names the CLI accepts beside --env and --lane (parseStageArgs refuses any other, and any repeat). */
export const ASSIGN_ARGS = { values: [] as string[], flags: ['--apply'] };

/** What a usage error prints (exit 2). */
export const USAGE =
  `Usage: npx tsx app/scripts/${SCRIPT_NAME}.ts --env local|dev|prod [--lane <L>] [--apply]\n` +
  '  DRY RUN by default; --apply writes. Unknown or repeated arguments are refused.\n' +
  '  --lane selects a hermetic e2e lane (local only).';

/** The CLI's outside world - each member injectable, so the tests execute every exit code. */
export interface AssignCliDeps {
  /** --env/--lane -> the stage client (default: resolveStageClient; for dev/prod the account guard runs first). */
  resolveStage: (target: StageTarget, opts: StageClientOpts) => Promise<StageClient>;
  /** The run on that client (default: assignPrimaryContacts on buildAssignDeps(stage)). */
  run: (stage: StageClient, opts: AssignOptions) => Promise<AssignResult>;
  /** One line of the printed summary (default: console.log). */
  print: (line: string) => void;
  /** The usage text (default: console.error). */
  printError: (text: string) => void;
  logger: Logger;
}

/**
 * The CLI (spec section 8). Resolves to the exit code: 2 a usage error
 * (nothing resolved, nothing read); 1 the target could not be resolved
 * (nothing read), the run aborted (the Scan failed - its PARTIAL line says
 * so), or it completed with failures (reportAssignRun); 0 it completed. Once
 * resolved, the stage client is destroyed whatever happens.
 */
export async function main(argv: readonly string[], cli: Partial<AssignCliDeps> = {}): Promise<0 | 1 | 2> {
  const printError = cli.printError ?? ((text: string) => console.error(text));
  const print = cli.print ?? ((line: string) => console.log(line));
  const log = cli.logger ?? defaultLogger;
  const resolveStage: AssignCliDeps['resolveStage'] =
    cli.resolveStage ?? ((target, opts) => resolveStageClient(target, {}, opts));
  const run: AssignCliDeps['run'] =
    cli.run ?? ((stage, opts) => assignPrimaryContacts(buildAssignDeps(stage, log), opts));

  const parsed = parseStageArgs([...argv], ASSIGN_ARGS);
  if ('usage' in parsed) {
    printError(USAGE);
    return 2;
  }
  const apply = parsed.flags.has('--apply');

  // STEP 1 - resolve the target on its own: a refusal here (account guard,
  // STS, an ambient AWS_ENDPOINT_URL*) happens BEFORE any table is read.
  let stage: StageClient;
  try {
    stage = await resolveStage(parsed.target, parsed.lane !== undefined ? { lane: parsed.lane } : {});
  } catch (err) {
    log.error({ err }, `${SCRIPT_NAME} - FAILED before the run started (no table was read or written)`);
    return 1;
  }
  // STEP 2 - the run, then the summary and the exit code it earns.
  try {
    log.info(
      { target: parsed.target, endpoint: stage.describe, prefix: stage.prefix, apply },
      `${SCRIPT_NAME} - starting`,
    );
    const result = await run(stage, { apply, logger: log });
    for (const line of formatAssignSummary(result, apply)) print(line);
    return reportAssignRun(result, apply, log);
  } catch (err) {
    log.error({ err }, `${SCRIPT_NAME} - FAILED: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  } finally {
    stage.doc.destroy();
  }
}

const invokedDirectly =
  import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith(`${SCRIPT_NAME}.ts`);
if (invokedDirectly) {
  void main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      defaultLogger.error({ err }, `${SCRIPT_NAME} - FAILED: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    },
  );
}
