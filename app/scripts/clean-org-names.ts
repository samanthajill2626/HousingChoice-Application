// clean-org-names - the ONE-TIME cleanup of stored housing authority and
// agency names (spec docs/superpowers/specs/2026-10-06-clean-org-names-and-
// caseworkers-design.md, section 8 and D14). AUTOMATIC mappings only:
//   - a value that resolves to exactly ONE listed name of its field's kind is
//     rewritten to that exact name;
//   - a housing authority value naming ONE agency moves to `agency` when the
//     contact's agency is empty (absent or '') or already that agency, and the
//     housing authority is REMOVED; otherwise both stay and it is counted as a
//     conflict;
//   - a property list member resolving to one housing authority is
//     rewritten; one naming an agency is dropped unless that would empty the
//     list; the list is de-duplicated;
//   - a property with only the legacy `jurisdiction` gets accepted_authorities
//     from it: the resolved name, or the raw value when it does not resolve.
// Everything else (a shared spelling, two names in one value, an unknown
// name) is LEFT exactly as it is and reported per field with its record
// count - the preview of Settings > Housing authorities & agencies > "Not on
// the list", where staff settle it.
//
// READS every contact (every type, deleted included; phone/email pointer rows
// skipped) and every unit (deleted included) from the BASE tables. Every
// write is CONDITIONAL on the record still holding what the run read, never
// stamps a unit's `updated_at` (the importer's human-ownership signal), and
// appends an `org_name_cleanup` audit event { field, from, to } per changed
// field - no actor (a script, not a person); `from` and `to` are strings, ''
// for an absent or removed value. It never touches broadcasts.
//
// THE LIST: the stage's stored `org-list` item, read WITHOUT creating it; the
// starting list (spec Appendix A) when none is stored yet - a dry run before
// the deploy. A DRY RUN (the default) writes nothing at all, the item
// included. `--apply` first takes the organization-list rewrite lock (spec
// D11: `lastRewrite` action `cleanup`; taking it creates the item, create-only,
// when absent) and refuses while another rewrite runs; it heartbeats the lock
// on elapsed time (at most every 20 s, checked before every record) and
// releases it `done`, or `failed` when it aborts or completes with failures.
// A heartbeat that finds the lock no longer its own stops the run at once,
// without releasing a lock that is not its own. After a hard kill the lock
// stops blocking 15 minutes after its last heartbeat.
//
// TARGET: `--env local|dev|prod` through scripts/lib/stageClient.ts (dev/prod:
// account guard first, client bound to the housingchoice profile). An agent
// runs this ONLY with `--env local --lane <L>` against a hermetic e2e lane it
// started. NO AGENT RUNS THIS AGAINST A REAL ENVIRONMENT; the human does, per
// the RUNBOOK.
//
//   npx tsx app/scripts/clean-org-names.ts --env dev
//   npx tsx app/scripts/clean-org-names.ts --env dev --apply
//
// PII: logs counts, record ids and field names, and prints organization
// values. Never a person's name, phone or email.
import { randomUUID } from 'node:crypto';
import { ScanCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { tableName } from '../src/lib/config.js';
import { logger as defaultLogger, type Logger } from '../src/lib/logger.js';
import { isOnListFor, KINDS_FOR_FIELD, resolveOrgText, type OrgEntry } from '../src/lib/orgNames.js';
import { buildStartingEntries } from '../src/lib/orgStartingList.js';
import { createAuditRepo, type AuditRepo } from '../src/repos/auditRepo.js';
import {
  createContactsRepo,
  EMAIL_REF_PREFIX,
  isDeleted as isContactDeleted,
  PHONE_REF_PREFIX,
  type ContactItem,
  type ContactsRepo,
} from '../src/repos/contactsRepo.js';
import { createOrgListRepo, type OrgListRepo, type OrgRewriteState } from '../src/repos/orgListRepo.js';
import { createUnitsRepo, isDeleted as isUnitDeleted, type UnitItem, type UnitsRepo } from '../src/repos/unitsRepo.js';
import { OrgHttpError } from '../src/services/orgNames.js';
import { createOrgRecordsService } from '../src/services/orgRecords.js';
import { createOrgRewriteService, type OrgRewriteService } from '../src/services/orgRewrite.js';
import { parseStageArgs, resolveStageClient, type StageClient } from './lib/stageClient.js';

// ---------------------------------------------------------------------------
// Planning (pure): what one record becomes
// ---------------------------------------------------------------------------

export type CleanupField = 'housingAuthority' | 'agency' | 'accepted_authorities';

/** Why a value is left for the Settings page (spec D4). */
export type LeftoverResolution = 'ambiguous' | 'other_kind' | 'compound' | 'unknown';

/**
 * The automatic changes, counted (dry run: would make; apply: made). The two
 * that write nothing - agencyConflicts and unitAgencyMembersKept - are
 * counted whether or not the record has a write.
 */
export interface CleanupChanges {
  /** Housing authority values rewritten to the exact name of the one entry they resolve to. */
  housingAuthorityRewritten: number;
  /** Housing authority values naming one agency, moved to `agency` (the housing authority removed). */
  movedToAgency: number;
  /** ...left instead: the contact's agency holds another value. */
  agencyConflicts: number;
  /** Agency values rewritten to the exact name of the one agency they resolve to. */
  agencyRewritten: number;
  /** Property list members rewritten to an exact housing authority name. */
  unitMembersRewritten: number;
  /** Property list members naming an agency, dropped. */
  unitAgencyMembersDropped: number;
  /** ...kept instead: dropping them would have emptied the list. */
  unitAgencyMembersKept: number;
  /** Duplicate members removed from property lists. */
  unitDuplicatesRemoved: number;
  /** Properties given accepted_authorities from their legacy jurisdiction. */
  jurisdictionBackfilled: number;
}

/**
 * One changed field of one record: its `org_name_cleanup` audit payload.
 * STRINGS only (plan 3.8 - the property Activity projection shows them only as
 * strings): a property list is joined with ", "; '' is absent or removed.
 */
export interface FieldAudit {
  field: CleanupField;
  /** The value before; '' = absent (a backfilled property had no list). */
  from: string;
  /** The value after; '' = removed. */
  to: string;
}

export interface ContactWrite {
  /** The two fields exactly as read - the write's condition (null = absent). */
  expect: { housingAuthority: string | null; agency: string | null };
  /** housingAuthority null = REMOVE. An omitted field is left untouched. */
  next: { housingAuthority?: string | null; agency?: string };
}

export interface UnitWrite {
  /** The list exactly as read (null = no list stored: a legacy unit). */
  expected: string[] | null;
  next: string[];
}

export interface RecordPlan<W> {
  /** The ONE conditional write, when anything changes. */
  write?: W;
  audits: FieldAudit[];
  changes: Partial<CleanupChanges>;
  leftovers: Array<{ field: CleanupField; value: string; resolution: LeftoverResolution }>;
}

const HA = KINDS_FOR_FIELD.housingAuthority;
const AGENCY = KINDS_FOR_FIELD.agency;
const LIST = KINDS_FOR_FIELD.accepted_authorities;

const isText = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

/** A whitespace-only housingAuthority or agency - not '', which is a cleared agency (spec D5). */
const isWhitespaceOnly = (v: unknown): boolean => typeof v === 'string' && v !== '' && v.trim() === '';
/** A blank list member: whitespace, or '' (what the body trim makes of whitespace; a list has no cleared member). */
const isBlankMember = (m: unknown): boolean => typeof m === 'string' && m.trim() === '';

function bump(changes: Partial<CleanupChanges>, key: keyof CleanupChanges, by = 1): void {
  if (by > 0) changes[key] = (changes[key] ?? 0) + by;
}

/**
 * The automatic changes for one contact (any type, active or deleted).
 * Throws on a malformed value (not a string) - the run counts the record
 * `failed` and steps over it.
 */
export function planContact(
  contact: { housingAuthority?: unknown; agency?: unknown },
  entries: readonly OrgEntry[],
): RecordPlan<ContactWrite> {
  const rawHa = contact.housingAuthority;
  const rawAgency = contact.agency;
  if (rawHa !== undefined && typeof rawHa !== 'string') throw new Error('housingAuthority is not a string');
  if (rawAgency !== undefined && typeof rawAgency !== 'string') throw new Error('agency is not a string');
  const ha = rawHa as string | undefined;
  const agency = rawAgency as string | undefined;
  const plan: RecordPlan<ContactWrite> = { audits: [], changes: {}, leftovers: [] };

  // Agency FIRST: a housing authority that names an agency may move only into
  // an agency that is empty or already that agency.
  let nextAgency: string | undefined = agency;
  if (isText(agency) && !isOnListFor(entries, agency, AGENCY)) {
    const r = resolveOrgText(entries, agency, AGENCY);
    if (r.status === 'match') {
      nextAgency = r.entry.name;
      bump(plan.changes, 'agencyRewritten');
    } else {
      plan.leftovers.push({ field: 'agency', value: agency, resolution: r.status });
    }
  }

  let nextHa: string | null | undefined = ha; // null = REMOVE
  if (isText(ha) && !isOnListFor(entries, ha, HA)) {
    const r = resolveOrgText(entries, ha, HA);
    if (r.status === 'match') {
      nextHa = r.entry.name;
      bump(plan.changes, 'housingAuthorityRewritten');
    } else {
      const asAgency = r.status === 'other_kind' ? resolveOrgText(entries, ha, AGENCY) : undefined;
      if (asAgency?.status === 'match') {
        const free = nextAgency === undefined || nextAgency.trim() === '' || nextAgency === asAgency.entry.name;
        if (free) {
          nextHa = null;
          nextAgency = asAgency.entry.name;
          bump(plan.changes, 'movedToAgency');
        } else {
          bump(plan.changes, 'agencyConflicts');
          plan.leftovers.push({ field: 'housingAuthority', value: ha, resolution: r.status });
        }
      } else {
        plan.leftovers.push({ field: 'housingAuthority', value: ha, resolution: r.status });
      }
    }
  }

  const haChanged = nextHa !== ha;
  const agencyChanged = nextAgency !== agency;
  if (!haChanged && !agencyChanged) return plan;
  plan.write = {
    expect: { housingAuthority: ha ?? null, agency: agency ?? null },
    next: {
      ...(haChanged && { housingAuthority: nextHa ?? null }),
      ...(agencyChanged && nextAgency !== undefined && { agency: nextAgency }),
    },
  };
  // Strings only (plan 3.8): '' for an absent or removed value.
  if (haChanged) plan.audits.push({ field: 'housingAuthority', from: ha ?? '', to: nextHa ?? '' });
  if (agencyChanged) plan.audits.push({ field: 'agency', from: agency ?? '', to: nextAgency ?? '' });
  return plan;
}

/**
 * The automatic changes for one unit (active or deleted). Throws on a
 * malformed list (not a list of strings) - the run counts the record
 * `failed` and steps over it.
 */
export function planUnit(
  unit: { accepted_authorities?: unknown; jurisdiction?: unknown },
  entries: readonly OrgEntry[],
): RecordPlan<UnitWrite> {
  const plan: RecordPlan<UnitWrite> = { audits: [], changes: {}, leftovers: [] };
  const stored = unit.accepted_authorities;
  if (stored === undefined) {
    // A LEGACY unit: no list, only `jurisdiction` (the forms and the flyer
    // synthesize a one-item list from it - unitFields.authoritiesOf). Give it
    // the list: the resolved name, or the raw value when it does not resolve.
    const legacy = unit.jurisdiction;
    if (!isText(legacy)) return plan;
    let value = legacy;
    if (!isOnListFor(entries, legacy, LIST)) {
      const r = resolveOrgText(entries, legacy, LIST);
      if (r.status === 'match') value = r.entry.name;
      else plan.leftovers.push({ field: 'accepted_authorities', value: legacy, resolution: r.status });
    }
    plan.write = { expected: null, next: [value] };
    // The audit is about the LIST, which was absent: from '' (plan 3.8). The
    // legacy `jurisdiction` itself is left as it is.
    plan.audits.push({ field: 'accepted_authorities', from: '', to: value });
    bump(plan.changes, 'jurisdictionBackfilled');
    return plan;
  }
  if (!Array.isArray(stored) || stored.some((m) => typeof m !== 'string')) {
    throw new Error('accepted_authorities is not a list of strings');
  }
  const members = stored as string[];

  // Each member: kept as it is, rewritten to its name, or flagged as an agency.
  const steps = members.map((raw) => {
    if (raw.trim() === '' || isOnListFor(entries, raw, LIST)) return { raw, value: raw, agency: false };
    const r = resolveOrgText(entries, raw, LIST);
    if (r.status === 'match') {
      bump(plan.changes, 'unitMembersRewritten');
      return { raw, value: r.entry.name, agency: false };
    }
    if (r.status !== 'other_kind') {
      plan.leftovers.push({ field: 'accepted_authorities', value: raw, resolution: r.status });
    }
    return { raw, value: raw, agency: r.status === 'other_kind' };
  });
  // An agency never belongs on a property: drop it - unless nothing else would
  // remain, in which case it stays and is left for the Settings page.
  const othersRemain = steps.some((s) => !s.agency);
  const kept: string[] = [];
  for (const s of steps) {
    if (s.agency && othersRemain) {
      bump(plan.changes, 'unitAgencyMembersDropped');
      continue;
    }
    if (s.agency) {
      bump(plan.changes, 'unitAgencyMembersKept');
      plan.leftovers.push({ field: 'accepted_authorities', value: s.raw, resolution: 'other_kind' });
    }
    kept.push(s.value);
  }
  const next = kept.filter((v, i) => kept.indexOf(v) === i);
  bump(plan.changes, 'unitDuplicatesRemoved', kept.length - next.length);
  const changed = next.length !== members.length || next.some((v, i) => v !== members[i]);
  if (changed) {
    plan.write = { expected: [...members], next };
    plan.audits.push({ field: 'accepted_authorities', from: members.join(', '), to: next.join(', ') });
  }
  return plan;
}

// ---------------------------------------------------------------------------
// The run (dry run by default; --apply writes under the rewrite lock)
// ---------------------------------------------------------------------------

export const SCRIPT_NAME = 'clean-org-names';

/** Heartbeat the lock at most this often while an apply runs. */
export const HEARTBEAT_EVERY_MS = 20_000;

/**
 * Another organization-name rewrite holds the lock (spec D11): nothing was
 * read or written. Exit 1, no PARTIAL banner.
 */
export class CleanupRefusedError extends Error {}

/**
 * The apply's heartbeat found the organization-list rewrite lock no longer
 * its own (spec D11): another rewrite took it over after it went 15 minutes
 * without a heartbeat, or it simply lapsed - a lapsed lock is no longer the
 * caller's (code review R2-BE-1). The run stopped writing at once and does NOT
 * release the lock. Exit 1, with the PARTIAL report.
 */
export class CleanupLockLostError extends Error {
  constructor(jobId: string) {
    super(
      `${SCRIPT_NAME}: lost the organization-list rewrite lock (job ${jobId}) - it lapsed (15 minutes without ` +
        'a heartbeat) or another rewrite took it over; stopped writing at once. ' +
        'Re-run the apply once no other rewrite is running (idempotent).',
    );
    this.name = 'CleanupLockLostError';
  }
}

export interface CleanupLeftover {
  field: CleanupField;
  value: string;
  /** Active records holding it. */
  count: number;
  /** Deleted records holding it. */
  deletedCount: number;
  resolution: LeftoverResolution;
}

export interface CleanupResult {
  /** The stored org-list item, or the starting list (no item stored yet). */
  listSource: 'stored' | 'starting';
  contactsScanned: number;
  unitsScanned: number;
  /** phone/email pointer rows in the contacts table - skipped. */
  pointerRows: number;
  /** Records with at least one automatic change (dry run: would change). */
  recordsPlanned: number;
  /** Records written (apply only). */
  recordsWritten: number;
  /** Writes whose condition failed - the record changed after the run read it; nothing written. Re-run. */
  skippedOnCondition: number;
  /** Records the run could not PLAN (a malformed value); stepped over, nothing written. */
  failed: number;
  /**
   * Apply only: `org_name_cleanup` events that could not be appended AFTER
   * their record write landed. Each is logged WARN with its record key and the
   * run goes on - aborting would leave a permanent gap, since a re-run finds
   * the record already clean and writes no event (code review R1-ADV-BE-4).
   * Expected 0.
   */
  auditFailed: number;
  /** Dry run: the changes it would make. Apply: the changes it made. */
  changes: CleanupChanges;
  /**
   * Contacts holding a non-empty housingAuthority or agency but lacking `type`
   * or `status` - the byTypeStatus keys. Expected 0: this base-table Scan sees
   * (and plans) them, but the rewrite job, the usage counts and "Not on the
   * list" read contacts through that index and never do. Counted only.
   */
  contactsMissingTypeOrStatus: number;
  /**
   * Records (contacts and units, deleted included) holding a value no request
   * can name and "Not on the list" never shows (code review R1-CONF-1): a
   * whitespace-only housingAuthority or agency (pre-2026-07-14 data, before
   * the body trim), or a blank accepted_authorities member. The cleanup leaves
   * them as they are. Expected 0. Counted only.
   */
  recordsWithBlankValues: number;
  /** Values the plan leaves for the Settings page: by field, most held first. */
  leftovers: CleanupLeftover[];
}

export interface CleanupDeps {
  orgList: Pick<OrgListRepo, 'peek'>;
  lock: Pick<OrgRewriteService, 'acquireForCleanup' | 'heartbeat' | 'finish'>;
  contacts: Pick<ContactsRepo, 'rewriteOrgFields'>;
  units: Pick<UnitsRepo, 'rewriteAcceptedAuthorities'>;
  audit: Pick<AuditRepo, 'append'>;
}

export interface CleanupOpts {
  doc: DynamoDBDocumentClient;
  env: NodeJS.ProcessEnv;
  /** Write. Absent/false = dry run (the default). */
  apply?: boolean;
  scanLimit?: number;
  logger?: Logger;
  /** Test seam: replace any of the deps buildCleanupDeps builds. */
  deps?: Partial<CleanupDeps>;
  /** Test seam: the clock (ms) that paces the heartbeat. */
  now?: () => number;
}

/** The real deps - every one on the run's doc client and stage env. */
export function buildCleanupDeps(doc: DynamoDBDocumentClient, env: NodeJS.ProcessEnv, logger: Logger): CleanupDeps {
  const orgListRepo = createOrgListRepo({ doc, env, logger });
  const contactsRepo = createContactsRepo({ doc, env, logger });
  const unitsRepo = createUnitsRepo({ doc, env, logger });
  const auditRepo = createAuditRepo({ doc, env, logger });
  return {
    orgList: orgListRepo,
    // The plan 3.4b factory, with EVERY repo it could reach built on the
    // stage's { doc, env } - a default-constructed one would resolve the ambient
    // TABLE_PREFIX. The three lock methods touch only the org-list item, and
    // the cleanup never queues a job: a stray enqueue fails loudly.
    lock: createOrgRewriteService({
      orgListRepo,
      orgRecords: createOrgRecordsService({ contactsRepo, unitsRepo, auditRepo, logger }),
      enqueue: async () => {
        throw new Error(`${SCRIPT_NAME} never enqueues a job`);
      },
      logger,
    }),
    contacts: contactsRepo,
    units: unitsRepo,
    audit: auditRepo,
  };
}

const NO_CHANGES: CleanupChanges = {
  housingAuthorityRewritten: 0,
  movedToAgency: 0,
  agencyConflicts: 0,
  agencyRewritten: 0,
  unitMembersRewritten: 0,
  unitAgencyMembersDropped: 0,
  unitAgencyMembersKept: 0,
  unitDuplicatesRemoved: 0,
  jurisdictionBackfilled: 0,
};

function emptyResult(): CleanupResult {
  return {
    listSource: 'starting',
    contactsScanned: 0,
    unitsScanned: 0,
    pointerRows: 0,
    recordsPlanned: 0,
    recordsWritten: 0,
    skippedOnCondition: 0,
    failed: 0,
    auditFailed: 0,
    changes: { ...NO_CHANGES },
    contactsMissingTypeOrStatus: 0,
    recordsWithBlankValues: 0,
    leftovers: [],
  };
}

/**
 * The counters as one flat record: every log line's fields (done, COMPLETED
 * WITH FAILURES, PARTIAL, the failed lock release) and the lock's `counts`. An
 * ABORTED apply prints no summary, so its gaps must ride here too (code review
 * R2-BE-2).
 */
function flatCounts(result: CleanupResult): Record<string, number> {
  return {
    contactsScanned: result.contactsScanned,
    unitsScanned: result.unitsScanned,
    pointerRows: result.pointerRows,
    recordsPlanned: result.recordsPlanned,
    recordsWritten: result.recordsWritten,
    skippedOnCondition: result.skippedOnCondition,
    failed: result.failed,
    auditFailed: result.auditFailed,
    recordsWithBlankValues: result.recordsWithBlankValues,
    ...result.changes,
  };
}

/** A byTypeStatus key as DynamoDB indexes it: present, and a non-empty string. */
const isIndexKey = (v: unknown): boolean => typeof v === 'string' && v !== '';

function addChanges(into: CleanupChanges, add: Partial<CleanupChanges>): void {
  for (const key of Object.keys(add) as Array<keyof CleanupChanges>) into[key] += add[key] ?? 0;
}

const FIELD_ORDER: readonly CleanupField[] = ['housingAuthority', 'agency', 'accepted_authorities'];

function tallyLeftovers(tally: Map<string, CleanupLeftover>, plan: RecordPlan<unknown>, deleted: boolean): void {
  for (const l of plan.leftovers) {
    const key = JSON.stringify([l.field, l.value]);
    const row = tally.get(key) ?? { field: l.field, value: l.value, count: 0, deletedCount: 0, resolution: l.resolution };
    if (deleted) row.deletedCount += 1;
    else row.count += 1;
    tally.set(key, row);
  }
}

function compareLeftovers(a: CleanupLeftover, b: CleanupLeftover): number {
  const byField = FIELD_ORDER.indexOf(a.field) - FIELD_ORDER.indexOf(b.field);
  if (byField !== 0) return byField;
  const byTotal = b.count + b.deletedCount - (a.count + a.deletedCount);
  if (byTotal !== 0) return byTotal;
  return a.value < b.value ? -1 : a.value > b.value ? 1 : 0;
}

/** Every item of one BASE table (deleted rows included), page by page. */
async function* scanAll(
  doc: DynamoDBDocumentClient,
  table: string,
  limit: number | undefined,
): AsyncGenerator<Record<string, unknown>> {
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const page = await doc.send(
      new ScanCommand({
        TableName: table,
        ConsistentRead: true,
        ...(limit !== undefined && { Limit: limit }),
        ...(exclusiveStartKey !== undefined && { ExclusiveStartKey: exclusiveStartKey }),
      }),
    );
    for (const item of (page.Items ?? []) as Record<string, unknown>[]) yield item;
    exclusiveStartKey = page.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (exclusiveStartKey !== undefined);
}

export async function cleanOrgNames(opts: CleanupOpts): Promise<CleanupResult> {
  const log = opts.logger ?? defaultLogger;
  const deps: CleanupDeps = { ...buildCleanupDeps(opts.doc, opts.env, log), ...opts.deps };
  const apply = opts.apply === true;
  const result = emptyResult();

  // APPLY: the lock FIRST, so a refusal reads and writes nothing (spec D11).
  let lock: OrgRewriteState | undefined;
  if (apply) {
    try {
      lock = await deps.lock.acquireForCleanup(SCRIPT_NAME);
    } catch (err) {
      if (err instanceof OrgHttpError && err.body.error === 'org_rewrite_running') {
        const held = err.body['lastRewrite'] as Partial<OrgRewriteState> | undefined;
        throw new CleanupRefusedError(
          `${SCRIPT_NAME}: REFUSED - another organization-name rewrite is running ` +
            `(action ${String(held?.action)}, started ${String(held?.startedAt)}, last heartbeat ${String(held?.heartbeatAt)}). ` +
            'Wait for it to finish (Settings > Housing authorities & agencies shows it); a rewrite whose ' +
            'process was killed stops blocking 15 minutes after its last heartbeat. Nothing was read or written.',
        );
      }
      log.error({ err }, `${SCRIPT_NAME} - could not take the rewrite lock; nothing was read or written`);
      throw err;
    }
    log.info({ jobId: lock.jobId }, `${SCRIPT_NAME} - took the organization-list rewrite lock (action cleanup)`);
  }

  try {
    await run(opts, deps, result, log, lock);
  } catch (err) {
    log.error(
      { ...flatCounts(result), apply },
      `${SCRIPT_NAME} - PARTIAL result: the run ABORTED and these counters cover only what completed before the failure. Every write is conditional, so re-running after the fix is safe.`,
    );
    // A lost lock is another rewrite's now: never finish it (spec D11).
    if (lock !== undefined && !(err instanceof CleanupLockLostError)) {
      await releaseAfterAbort(deps, lock.jobId, result, err, log);
    }
    throw err;
  }

  if (lock !== undefined) {
    const failed = result.failed > 0;
    try {
      await deps.lock.finish(
        lock.jobId,
        failed
          ? { status: 'failed', counts: flatCounts(result), error: `${result.failed} record(s) could not be planned` }
          : { status: 'done', counts: flatCounts(result) },
      );
    } catch (err) {
      // The run itself COMPLETED; only the release failed. Say so here - the
      // CLI names the error itself, and there is no PARTIAL report to point at.
      log.error(
        { err, jobId: lock.jobId, ...flatCounts(result) },
        `${SCRIPT_NAME} - the run COMPLETED (these counters are what it wrote) but the rewrite lock could not be released; it stops blocking other rewrites 15 minutes after its last heartbeat`,
      );
      throw err;
    }
    log.info({ jobId: lock.jobId, status: failed ? 'failed' : 'done' }, `${SCRIPT_NAME} - released the rewrite lock`);
  }
  return result;
}

/** The abort path's release: never masks the run's own error. */
async function releaseAfterAbort(
  deps: CleanupDeps,
  jobId: string,
  result: CleanupResult,
  err: unknown,
  log: Logger,
): Promise<void> {
  try {
    await deps.lock.finish(jobId, {
      status: 'failed',
      counts: flatCounts(result),
      error: (err instanceof Error ? err.message : String(err)).slice(0, 500),
    });
    log.info({ jobId }, `${SCRIPT_NAME} - released the rewrite lock as failed`);
  } catch (releaseErr) {
    log.error(
      { err: releaseErr, jobId },
      `${SCRIPT_NAME} - could NOT release the rewrite lock; it stops blocking other rewrites 15 minutes after its last heartbeat`,
    );
  }
}

async function run(
  opts: CleanupOpts,
  deps: CleanupDeps,
  result: CleanupResult,
  log: Logger,
  lock: OrgRewriteState | undefined,
): Promise<void> {
  const { doc, env } = opts;
  const now = opts.now ?? Date.now;

  // The list, read WITHOUT creating it. An apply created it (create-only) when
  // it took the lock; a dry run before the deploy finds none and resolves
  // against the starting list in memory.
  const stored = await deps.orgList.peek();
  const entries: readonly OrgEntry[] =
    stored?.entries ?? buildStartingEntries(new Date().toISOString(), () => randomUUID());
  result.listSource = stored !== null ? 'stored' : 'starting';
  log.info(
    { listSource: result.listSource, entries: entries.length, apply: lock !== undefined },
    `${SCRIPT_NAME} - resolving against the ${stored !== null ? 'stored organization list' : 'starting list (no org-list item is stored yet)'}`,
  );

  let lastBeat = now();
  /**
   * The lock's heartbeat on ELAPSED time: checked before EVERY row, written or
   * not, so a long stretch with nothing to write still keeps the lock alive.
   * A heartbeat that cannot be written (a busy list) is logged and the run
   * goes on - the lock goes stale only after 15 minutes without one. One that
   * answers false means another rewrite holds the lock now: stop at once.
   */
  const beat = async (): Promise<void> => {
    if (lock === undefined || now() - lastBeat < HEARTBEAT_EVERY_MS) return;
    lastBeat = now();
    let ours: boolean;
    try {
      ours = await deps.lock.heartbeat(lock.jobId);
    } catch (err) {
      log.warn({ err, jobId: lock.jobId }, `${SCRIPT_NAME} - heartbeat failed; continuing`);
      return;
    }
    if (!ours) throw new CleanupLockLostError(lock.jobId);
  };
  /**
   * One `org_name_cleanup` event. It is appended AFTER the record write
   * landed, so a failure is logged and counted, never thrown (code review
   * R1-ADV-BE-4; the org.rewrite pass does the same, services/orgRecords.ts).
   */
  const appendAudit = async (entityKey: string, a: FieldAudit): Promise<void> => {
    try {
      await deps.audit.append(entityKey, 'org_name_cleanup', { field: a.field, from: a.from, to: a.to });
    } catch (err) {
      result.auditFailed += 1;
      log.warn(
        { err, entityKey, field: a.field },
        `${SCRIPT_NAME} - audit event could NOT be written (the record change landed); counted in auditFailed, continuing`,
      );
    }
  };
  const tally = new Map<string, CleanupLeftover>();

  for await (const row of scanAll(doc, tableName('contacts', env), opts.scanLimit)) {
    await beat();
    const contactId = String(row['contactId'] ?? '');
    if (contactId.startsWith(PHONE_REF_PREFIX) || contactId.startsWith(EMAIL_REF_PREFIX)) {
      result.pointerRows += 1;
      continue;
    }
    result.contactsScanned += 1;
    // Invisible to every index-based reader (contactsMissingTypeOrStatus):
    // counted only - it is planned and written like any other contact.
    if ((isText(row['housingAuthority']) || isText(row['agency'])) && !(isIndexKey(row['type']) && isIndexKey(row['status']))) {
      result.contactsMissingTypeOrStatus += 1;
    }
    // Invisible to Settings as well (recordsWithBlankValues): counted only.
    if (isWhitespaceOnly(row['housingAuthority']) || isWhitespaceOnly(row['agency'])) result.recordsWithBlankValues += 1;
    let plan: RecordPlan<ContactWrite>;
    try {
      plan = planContact(row, entries);
    } catch (err) {
      result.failed += 1;
      log.error({ err, contactId }, `${SCRIPT_NAME} - contact could not be PLANNED; stepped over and counted failed`);
      continue;
    }
    // The repos' own "deleted" rule (a NON-EMPTY deleted_at string), so these
    // counts match what Settings > "Not on the list" shows; it reads only that attribute.
    tallyLeftovers(tally, plan, isContactDeleted(row as Pick<ContactItem, 'deleted_at'>));
    if (plan.write === undefined) {
      // Nothing to write - but a conflict is still a decision the run counts.
      addChanges(result.changes, plan.changes);
      continue;
    }
    result.recordsPlanned += 1;
    const fields = plan.audits.map((a) => a.field);
    if (lock === undefined) {
      addChanges(result.changes, plan.changes);
      log.info({ contactId, fields }, `${SCRIPT_NAME} - DRY RUN: would clean`);
      continue;
    }
    const outcome = await deps.contacts.rewriteOrgFields(contactId, plan.write.expect, plan.write.next);
    if (outcome === 'skipped') {
      result.skippedOnCondition += 1;
      log.info({ contactId }, `${SCRIPT_NAME} - the contact changed under the run; skipped, nothing written`);
    } else {
      result.recordsWritten += 1;
      addChanges(result.changes, plan.changes);
      for (const a of plan.audits) await appendAudit(`contacts#${contactId}`, a);
      log.info({ contactId, fields }, `${SCRIPT_NAME} - contact cleaned`);
    }
  }

  for await (const row of scanAll(doc, tableName('units', env), opts.scanLimit)) {
    await beat();
    const unitId = String(row['unitId'] ?? '');
    result.unitsScanned += 1;
    const members = row['accepted_authorities'];
    if (Array.isArray(members) && members.some(isBlankMember)) result.recordsWithBlankValues += 1;
    let plan: RecordPlan<UnitWrite>;
    try {
      plan = planUnit(row, entries);
    } catch (err) {
      result.failed += 1;
      log.error({ err, unitId }, `${SCRIPT_NAME} - unit could not be PLANNED; stepped over and counted failed`);
      continue;
    }
    tallyLeftovers(tally, plan, isUnitDeleted(row as Pick<UnitItem, 'deleted_at'>));
    if (plan.write === undefined) {
      // Nothing to write - but an agency kept as a list's only member is still counted.
      addChanges(result.changes, plan.changes);
      continue;
    }
    result.recordsPlanned += 1;
    if (lock === undefined) {
      addChanges(result.changes, plan.changes);
      log.info({ unitId }, `${SCRIPT_NAME} - DRY RUN: would clean`);
      continue;
    }
    const outcome = await deps.units.rewriteAcceptedAuthorities(unitId, plan.write.expected, plan.write.next);
    if (outcome === 'skipped') {
      result.skippedOnCondition += 1;
      log.info({ unitId }, `${SCRIPT_NAME} - the unit changed under the run; skipped, nothing written`);
    } else {
      result.recordsWritten += 1;
      addChanges(result.changes, plan.changes);
      for (const a of plan.audits) await appendAudit(`units#${unitId}`, a);
      log.info({ unitId }, `${SCRIPT_NAME} - unit cleaned`);
    }
  }

  result.leftovers = [...tally.values()].sort(compareLeftovers);
}

/** The end-of-run report and the exit code it earns (failed > 0 exits 1). */
export function reportCleanupRun(result: CleanupResult, apply: boolean, log: Logger = defaultLogger): 0 | 1 {
  const suffix = apply ? '' : ' (DRY RUN - nothing written)';
  const fields = {
    ...flatCounts(result),
    listSource: result.listSource,
    leftoverValues: result.leftovers.length,
    contactsMissingTypeOrStatus: result.contactsMissingTypeOrStatus,
    apply,
  };
  if (result.failed > 0) {
    log.warn(
      fields,
      `${SCRIPT_NAME} - COMPLETED WITH FAILURES${suffix}: ${result.failed} record(s) could not be planned and were stepped over, nothing written for them (see the ERROR lines naming them). Investigate, then re-run (idempotent).`,
    );
    return 1;
  }
  if (result.auditFailed > 0) {
    // Still a completed run (exit 0) - but at WARN, so a level-filtered view
    // shows the audit gap (code review R2-BE-2).
    log.warn(
      fields,
      `${SCRIPT_NAME} - done${suffix}: ${result.auditFailed} audit event(s) could not be written (each record change landed; see the WARN lines naming them)`,
    );
    return 0;
  }
  log.info(fields, `${SCRIPT_NAME} - done${suffix}`);
  return 0;
}

// ---------------------------------------------------------------------------
// The printed summary and the CLI
// ---------------------------------------------------------------------------

const CHANGE_LABELS: Readonly<Record<keyof CleanupChanges, string>> = {
  housingAuthorityRewritten: 'housing authority spelling -> its list name',
  movedToAgency: 'agency named as housing authority -> moved to Agency',
  agencyConflicts: 'agency named as housing authority, Agency already set (left)',
  agencyRewritten: 'agency spelling -> its list name',
  unitMembersRewritten: 'property authority spelling -> its list name',
  unitAgencyMembersDropped: 'agency dropped from a property list',
  unitAgencyMembersKept: 'agency kept on a property (its only entry)',
  unitDuplicatesRemoved: 'duplicate dropped from a property list',
  jurisdictionBackfilled: 'property list filled from its legacy jurisdiction',
};

const LEFTOVER_WHY: Readonly<Record<LeftoverResolution, string>> = {
  ambiguous: 'a spelling more than one listed name shares',
  other_kind: 'an agency, not a housing authority',
  compound: 'names more than one organization',
  unknown: 'not on the list',
};

/**
 * What the CLI prints: the change counts, then every value left for the
 * Settings page with its record counts and why. Organization values only -
 * never a person's name.
 */
export function formatSummary(result: CleanupResult, apply: boolean): string[] {
  const lines = [apply ? 'Automatic changes made:' : 'Automatic changes this run WOULD make (dry run):'];
  for (const key of Object.keys(CHANGE_LABELS) as Array<keyof CleanupChanges>) {
    lines.push(`  ${String(result.changes[key]).padStart(6)}  ${CHANGE_LABELS[key]}`);
  }
  // The apply's audit gaps (code review R1-ADV-BE-4). A dry run appends no event.
  if (apply) {
    lines.push(
      `Audit events that could not be written: ${result.auditFailed} (expected 0 - each record change landed; each gap is named in a WARN line)`,
    );
  }
  if (result.leftovers.length === 0) {
    lines.push('Nothing is left for Settings > Housing authorities & agencies: every value is a list name.');
  } else {
    lines.push(`Left for Settings > Housing authorities & agencies > Not on the list (${result.leftovers.length} value(s)):`);
    for (const l of result.leftovers) {
      const deleted = l.deletedCount > 0 ? ` (+${l.deletedCount} deleted)` : '';
      const why =
        l.resolution === 'other_kind' && l.field === 'agency' ? 'a housing authority, not an agency' : LEFTOVER_WHY[l.resolution];
      lines.push(`  ${l.field}  ${JSON.stringify(l.value)}  x${l.count}${deleted}  - ${why}`);
    }
  }
  // Records holding a blank value (code review R1-CONF-1): nothing above lists
  // them, and "Not on the list" never shows them.
  lines.push(
    `Records holding a whitespace-only housing authority or agency, or a blank property-list member: ${result.recordsWithBlankValues} (expected 0 - Settings cannot see or settle them)`,
  );
  // Beside the leftovers: contacts the Settings page cannot see at all (no
  // byTypeStatus key) - their values above never reach "Not on the list".
  lines.push(
    `Contacts missing type or status but holding a housing authority or agency: ${result.contactsMissingTypeOrStatus} (expected 0 - Settings cannot see or rewrite them)`,
  );
  return lines;
}

/** The argument names the CLI accepts beside --env and --lane. */
export const CLEANUP_ARGS = { values: [] as string[], flags: ['--apply'] };

const invokedDirectly =
  import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('clean-org-names.ts');
if (invokedDirectly) {
  const parsed = parseStageArgs(process.argv.slice(2), CLEANUP_ARGS);
  if ('usage' in parsed) {
    console.error(
      `Usage: npx tsx app/scripts/${SCRIPT_NAME}.ts --env local|dev|prod [--lane <L>] [--apply]\n` +
        '  DRY RUN by default; --apply writes (and takes the organization-list rewrite lock). Unknown or\n' +
        '  repeated arguments are refused. --lane selects a hermetic e2e lane (local only).',
    );
    process.exit(2);
  }
  const apply = parsed.flags.has('--apply');
  void (async () => {
    // STEP 1 - resolve the target on its own: a refusal here (account guard,
    // STS, an ambient AWS_ENDPOINT_URL*) happens BEFORE any table is read.
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
      const result = await cleanOrgNames({ doc: stage.doc, env: stage.env, apply });
      for (const line of formatSummary(result, apply)) console.log(line);
      process.exitCode = reportCleanupRun(result, apply);
    } catch (err) {
      if (err instanceof CleanupRefusedError) {
        console.error(err.message);
        process.exitCode = 1;
        return;
      }
      // Name the REAL failure: the run logged a PARTIAL report itself only when
      // it aborted mid-run (a lost lock included); a lock that could not be
      // taken or released has none to point at.
      defaultLogger.error({ err }, `${SCRIPT_NAME} - FAILED: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    } finally {
      stage.doc.destroy();
    }
  })();
}
