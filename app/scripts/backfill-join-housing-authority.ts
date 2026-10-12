// backfill-join-housing-authority - the ONE-TIME backfill of a housing
// authority onto the /join leads that arrived before the form asked for one
// (spec docs/superpowers/specs/2026-10-12-join-housing-authority-design.md,
// D10 and D11). It gives "Atlanta Housing Authority" to every CANDIDATE that
// is not LEFT OUT, and changes nothing else - status included.
//
// CANDIDATES: contacts in the contacts BASE table (phone/email pointer rows
// skipped) with capture_source 'housing_fair', type 'tenant', not deleted, no
// housingAuthority attribute and no housing_fair_signup_v2 marker (every
// contact the sign-up creates after the change carries it - spec D5).
//
// LEFT OUT, and listed with the reason: a candidate named in --skip; one with
// a post-change sign-up (a housing_fair_signup event carrying signupVersion 2,
// spec D7); one whose audit trail shows housingAuthority was ever SET OR
// REMOVED (touchesHousingAuthority). Both audit rules read the WHOLE history:
// auditRepo.listByEntity is one newest-first Query with no cursor, so the run
// pages backward with `before` until a page comes back empty.
//
// THE LIST: the stored org-list item, read with peek() - never created. The
// run REFUSES (exit 1, no contact read, nothing written) when no item is
// stored, when "Atlanta Housing Authority" is not the exact name of a
// housing_authority entry, or - for --apply - while an organization-name
// rewrite is running by the system's own rule (isOrgRewriteRunning: a lock
// with no heartbeat for 15 minutes is free). It never takes the rewrite lock:
// after an apply that wrote, it reads the list again and WARNS when the name
// left the list during the run (the written records then show under Settings >
// Housing authorities & agencies > "Not on the list").
//
// DRY RUN (the default) writes nothing at all - not even the list item.
// --apply writes, per target, ONE conditional contactsRepo.update - the
// authority is set only while the contact still has none, is still a tenant
// and is still not deleted; a lost condition is counted `skipped` - then one
// housing_authority_backfill audit event { field, from: '', to }, no actor.
// Each candidate's history is read right before its write.
//
// TARGET: --env local|dev|prod through scripts/lib/stageClient.ts. An agent
// runs this ONLY with --env local --lane <L> against a hermetic e2e lane it
// started. NO AGENT RUNS THIS AGAINST A REAL ENVIRONMENT; the human does, per
// the RUNBOOK.
//
//   npx tsx app/scripts/backfill-join-housing-authority.ts --env dev
//   npx tsx app/scripts/backfill-join-housing-authority.ts --env dev --apply --skip "<contactId>,<contactId>"
//
// PII: the PRINTED report names each lead (first and last name) - the
// operator's recognition aid (Cameron 2026-10-12, a deliberate departure from
// clean-org-names). Structured log lines carry counts and contactIds only,
// never a name or phone.
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { ScanCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { tableName } from '../src/lib/config.js';
import { logger as defaultLogger, type Logger } from '../src/lib/logger.js';
import { isOnListFor, KINDS_FOR_FIELD } from '../src/lib/orgNames.js';
import { createAuditRepo, type AuditEvent, type AuditRepo } from '../src/repos/auditRepo.js';
import {
  createContactsRepo,
  EMAIL_REF_PREFIX,
  isDeleted,
  PHONE_REF_PREFIX,
  type ContactItem,
  type ContactsRepo,
} from '../src/repos/contactsRepo.js';
import { createOrgListRepo, type OrgListItem, type OrgListRepo } from '../src/repos/orgListRepo.js';
import { isOrgRewriteRunning } from '../src/services/orgNames.js';
import {
  parseStageArgs,
  resolveStageClient,
  type StageClient,
  type StageClientOpts,
  type StageTarget,
} from './lib/stageClient.js';

// ---------------------------------------------------------------------------
// The rules (pure): who is a candidate, and which history leaves one out
// ---------------------------------------------------------------------------

export const SCRIPT_NAME = 'backfill-join-housing-authority';

/** Spec D10: the one authority the backfill writes - an exact housing_authority name. */
export const BACKFILL_AUTHORITY = 'Atlanta Housing Authority';

/** Spec D10: the audit event each backfill write appends. */
export const BACKFILL_AUDIT_TYPE = 'housing_authority_backfill';

/** Why a candidate is left out: listed with the reason, never written. */
export type LeftOutReason = 'skipped' | 'signed_up_again' | 'authority_history';

/** The capture_source only the sign-up route writes (a /join sign-up, or a flyer one for an unshareable unit). */
const JOIN_CAPTURE_SOURCE = 'housing_fair';

/** Spec D5: every contact the sign-up creates after the change carries it. */
const SIGNUP_MARKER = 'housing_fair_signup_v2';

const FIELD = 'housingAuthority';

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Spec D10: a pre-change /join lead with no housing authority, judged on the
 * stored item alone - capture_source 'housing_fair', a tenant, not deleted
 * (the repos' rule), no housingAuthority attribute and no sign-up marker (a
 * marker of any value counts as present). Status is not a condition.
 */
export function isCandidate(contact: ContactItem): boolean {
  return (
    contact.capture_source === JOIN_CAPTURE_SOURCE &&
    contact.type === 'tenant' &&
    !isDeleted(contact) &&
    contact[FIELD] === undefined &&
    contact[SIGNUP_MARKER] === undefined
  );
}

/**
 * True when one audit event records housingAuthority being SET or REMOVED,
 * read in each writer's own payload shape (verified on main @19607658):
 *   - contact_updated: `fields` names it - the staff PATCH lists every field
 *     its body carried (routes/contacts.ts; the edit form sends the field only
 *     when it changed), and the caseworker conversion lists every key of its
 *     patch, which always REMOVEs it (services/caseworkerConversion.ts);
 *   - ai_extraction_applied: `fields[].field` names it (services/extraction/apply.ts);
 *   - ai_suggestion_accepted: `target` names it (services/suggestionResolution.ts);
 *   - org_name_rewrite / org_name_cleanup: `field` names it
 *     (services/orgRecords.ts, scripts/clean-org-names.ts);
 *   - housing_authority_backfill: this script's own event, whatever it carries.
 */
export function touchesHousingAuthority(event: AuditEvent): boolean {
  const payload: Record<string, unknown> = isRecord(event.payload) ? event.payload : {};
  const fields = payload['fields'];
  switch (event.event_type) {
    case 'contact_updated':
      return Array.isArray(fields) && fields.includes(FIELD);
    case 'ai_extraction_applied':
      return Array.isArray(fields) && fields.some((f: unknown) => isRecord(f) && f['field'] === FIELD);
    case 'ai_suggestion_accepted':
      return payload['target'] === FIELD;
    case 'org_name_rewrite':
    case 'org_name_cleanup':
      return payload['field'] === FIELD;
    case BACKFILL_AUDIT_TYPE:
      return true;
    default:
      return false;
  }
}

/**
 * Spec D10: why a candidate's WHOLE audit history (any order) leaves it out,
 * or null. A post-change sign-up (housing_fair_signup carrying the number
 * signupVersion 2 - on /join or a flyer, erring safe) wins over an authority
 * history: both leave the lead out, and it is the reason the operator most
 * needs to see.
 */
export function leftOutReasonFromAudit(events: readonly AuditEvent[]): Exclude<LeftOutReason, 'skipped'> | null {
  const signedUpAgain = events.some(
    (e) => e.event_type === 'housing_fair_signup' && isRecord(e.payload) && e.payload['signupVersion'] === 2,
  );
  if (signedUpAgain) return 'signed_up_again';
  return events.some(touchesHousingAuthority) ? 'authority_history' : null;
}

// ---------------------------------------------------------------------------
// The report (pure): what a run returns, and what the operator reads
// ---------------------------------------------------------------------------

/** One candidate as the report shows it. Names reach the PRINTED report only, never a log line. */
export interface BackfillLead {
  contactId: string;
  /** '' when the record has none. */
  firstName: string;
  /** '' when the record has none. */
  lastName: string;
  /** captured_at, else created_at (ISO 8601); '' when it has neither. The sort key. */
  signedUpAt: string;
  /** As stored (needs_review, on_hold, ...); '' when absent. */
  status: string;
}

/**
 * What became of one target: would_write (dry run); written; skipped (its
 * write lost its condition - the lead changed after the read, nothing
 * written); failed (its history read or its write threw - nothing written;
 * the run exits 1).
 */
export type TargetOutcome = 'would_write' | 'written' | 'skipped' | 'failed';

export interface BackfillTarget extends BackfillLead {
  outcome: TargetOutcome;
}

export interface LeftOutLead extends BackfillLead {
  reason: LeftOutReason;
}

export interface BackfillReport {
  /** Every lead the run set, would set, or failed on - oldest sign-up first. */
  targets: BackfillTarget[];
  /** Candidates left out, with the reason - oldest sign-up first. */
  leftOut: LeftOutLead[];
  /** --skip ids that named no candidate, sorted: reported, otherwise ignored. */
  unknownSkips: string[];
  /** Apply: targets written. */
  written: number;
  /** Apply: targets whose write lost its condition (changed after the read). */
  skipped: number;
  /** Targets whose history read or write failed: nothing written for them. */
  failed: number;
  /** Printed as WARNING lines: the post-apply list check, a missing audit event. */
  warnings: string[];
}

const REASON_TEXT: Readonly<Record<LeftOutReason, string>> = {
  skipped: 'named in --skip',
  signed_up_again: 'signed up again after the change',
  authority_history: 'its housing authority was set or removed before - left empty on purpose',
};

const OUTCOME_SUFFIX: Readonly<Record<TargetOutcome, string>> = {
  would_write: '',
  written: '',
  skipped: '  - SKIPPED: it changed after the run read it (nothing written)',
  failed: '  - FAILED: nothing written (an ERROR line names this contactId); re-run',
};

/** "2026-06-20" from an ISO stamp (UTC); "unknown" when there is none. */
function signUpDate(signedUpAt: string): string {
  return /^\d{4}-\d{2}-\d{2}/.test(signedUpAt) ? signedUpAt.slice(0, 10) : 'unknown';
}

function leadLine(lead: BackfillLead): string {
  const name = `${lead.firstName} ${lead.lastName}`.trim();
  return (
    `  ${name === '' ? '(no name)' : name}  signed up ${signUpDate(lead.signedUpAt)}` +
    `  status ${lead.status === '' ? '(none)' : lead.status}  contactId ${lead.contactId}`
  );
}

/**
 * Spec D10: what the CLI prints - each target on its own line (name, sign-up
 * date, status, contactId), oldest first, then the count; then the left-out
 * leads the same way with the reason; then unknown --skip ids and warnings.
 */
export function formatBackfillReport(report: BackfillReport, apply: boolean): string[] {
  const lines: string[] = [
    apply
      ? `Leads given "${BACKFILL_AUTHORITY}" (oldest sign-up first; dates are UTC):`
      : `DRY RUN - nothing written. Leads that WOULD get "${BACKFILL_AUTHORITY}" (oldest sign-up first; dates are UTC):`,
  ];
  if (report.targets.length === 0) lines.push('  (none)');
  for (const t of report.targets) lines.push(`${leadLine(t)}${OUTCOME_SUFFIX[t.outcome]}`);
  const wouldWrite = report.targets.filter((t) => t.outcome === 'would_write').length;
  lines.push(
    apply
      ? `Written: ${report.written}. Skipped (changed after the read): ${report.skipped}. Failed: ${report.failed}.`
      : `Would update: ${wouldWrite} lead(s). Failed: ${report.failed}.`,
  );
  if (report.leftOut.length === 0) {
    lines.push('Left out: none.');
  } else {
    lines.push(`Left out (${report.leftOut.length} lead(s), oldest sign-up first):`);
    for (const l of report.leftOut) lines.push(`${leadLine(l)}  - ${REASON_TEXT[l.reason]}`);
  }
  if (report.unknownSkips.length > 0) {
    lines.push(`--skip ids that are not candidates (ignored): ${report.unknownSkips.join(', ')}`);
  }
  for (const w of report.warnings) lines.push(`WARNING: ${w}`);
  return lines;
}

/** Spec D10: 0 completed clean (warnings included); 1 completed with failures. Refusals and usage are the CLI's. */
export function backfillExitCode(report: BackfillReport): 0 | 1 {
  return report.failed > 0 ? 1 : 0;
}

// ---------------------------------------------------------------------------
// The reads: the list check, the candidates, a candidate's whole history
// ---------------------------------------------------------------------------

/**
 * The run refused before it read any contact (spec D10): no organization list
 * is stored, "Atlanta Housing Authority" is not an exact housing_authority
 * name on it, or - for --apply - an organization-name rewrite is running.
 * Nothing was written. Exit 1.
 */
export class BackfillRefusedError extends Error {}

/** The audit history page size (listByEntity's Limit). */
export const AUDIT_PAGE_SIZE = 100;

export interface BackfillDeps {
  /** The stage's client: the contacts base-table Scan runs on it. */
  doc: DynamoDBDocumentClient;
  /** The stage's env (its TABLE_PREFIX): every table name resolves from it. */
  env: NodeJS.ProcessEnv;
  orgList: Pick<OrgListRepo, 'peek'>;
  contacts: Pick<ContactsRepo, 'update'>;
  audit: Pick<AuditRepo, 'append' | 'listByEntity'>;
  /** One line of the operator report (the CLI prints it). Names go here, never to the logger. */
  print: (line: string) => void;
  /** Wall clock in ms: the rewrite lock's staleness test (isOrgRewriteRunning). */
  now: () => number;
  logger: Logger;
  /** Test seam: the Scan page size (unset = DynamoDB's own page). */
  scanLimit?: number;
  /** Test seam: the audit history page size (unset = AUDIT_PAGE_SIZE). */
  auditPageSize?: number;
}

/** The real deps: every repo on the stage's doc client and env - never the ambient TABLE_PREFIX. */
export function buildBackfillDeps(
  stage: { doc: DynamoDBDocumentClient; env: NodeJS.ProcessEnv },
  opts: { logger?: Logger; print?: (line: string) => void; now?: () => number } = {},
): BackfillDeps {
  const logger = opts.logger ?? defaultLogger;
  const { doc, env } = stage;
  return {
    doc,
    env,
    orgList: createOrgListRepo({ doc, env, logger }),
    contacts: createContactsRepo({ doc, env, logger }),
    audit: createAuditRepo({ doc, env, logger }),
    print: opts.print ?? ((line: string) => console.log(line)),
    now: opts.now ?? Date.now,
    logger,
  };
}

const NOTHING_DONE = 'No contact was read and nothing was written.';

/**
 * Spec D10: the list checks, BEFORE any contact is read. The stored item only
 * (peek - never created, never the starting list); for --apply, the system's
 * own rewrite-lock rule. Throws BackfillRefusedError.
 */
export async function checkBackfillList(deps: Pick<BackfillDeps, 'orgList' | 'now'>, apply: boolean): Promise<void> {
  const item = await deps.orgList.peek();
  if (item === null) {
    throw new BackfillRefusedError(
      `${SCRIPT_NAME}: REFUSED - this environment has no organization list yet: the deployed app creates it on its first read. ` +
        `Open Settings > Housing authorities & agencies once, then re-run. ${NOTHING_DONE}`,
    );
  }
  if (!isOnListFor(item.entries, BACKFILL_AUTHORITY, KINDS_FOR_FIELD.housingAuthority)) {
    throw new BackfillRefusedError(
      `${SCRIPT_NAME}: REFUSED - "${BACKFILL_AUTHORITY}" is not the exact name of a housing authority on this ` +
        "environment's organization list (renamed, merged, deleted or made an agency). Check Settings > Housing authorities & agencies " +
        `before going on. ${NOTHING_DONE}`,
    );
  }
  const held = item.lastRewrite;
  if (apply && held !== undefined && isOrgRewriteRunning(held, deps.now())) {
    throw new BackfillRefusedError(
      `${SCRIPT_NAME}: REFUSED - an organization-name rewrite is running (action ${held.action}, started ` +
        `${held.startedAt}, last heartbeat ${held.heartbeatAt}). Wait for it to finish (Settings > Housing ` +
        'authorities & agencies shows it); a rewrite whose process was killed stops blocking 15 minutes after its last ' +
        `heartbeat. ${NOTHING_DONE}`,
    );
  }
}

/** Every item of one BASE table (deleted rows included), page by page - the clean-org-names loop. */
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

const text = (v: unknown): string => (typeof v === 'string' ? v : '');

function toLead(contact: ContactItem): BackfillLead {
  const capturedAt = text(contact.captured_at);
  return {
    contactId: contact.contactId,
    firstName: text(contact['firstName']),
    lastName: text(contact['lastName']),
    signedUpAt: capturedAt !== '' ? capturedAt : text(contact.created_at),
    status: text(contact.status),
  };
}

/** Oldest sign-up first; a lead with no date last; then by contactId. */
function compareLeads(a: BackfillLead, b: BackfillLead): number {
  if (a.signedUpAt !== b.signedUpAt) {
    if (a.signedUpAt === '') return 1;
    if (b.signedUpAt === '') return -1;
    return a.signedUpAt < b.signedUpAt ? -1 : 1;
  }
  return a.contactId < b.contactId ? -1 : a.contactId > b.contactId ? 1 : 0;
}

export interface CandidateScan {
  /** The candidates (spec D10), oldest sign-up first. */
  leads: BackfillLead[];
  /** Contacts read (pointer rows not counted). */
  contactsScanned: number;
  /** phone/email pointer rows - skipped. */
  pointerRows: number;
}

/** Spec D10: one consistent Scan of the contacts BASE table (pointer rows skipped, as the cleanup does). */
export async function scanCandidates(deps: Pick<BackfillDeps, 'doc' | 'env' | 'scanLimit'>): Promise<CandidateScan> {
  const scan: CandidateScan = { leads: [], contactsScanned: 0, pointerRows: 0 };
  for await (const row of scanAll(deps.doc, tableName('contacts', deps.env), deps.scanLimit)) {
    const contactId = String(row['contactId'] ?? '');
    if (contactId.startsWith(PHONE_REF_PREFIX) || contactId.startsWith(EMAIL_REF_PREFIX)) {
      scan.pointerRows += 1;
      continue;
    }
    scan.contactsScanned += 1;
    const contact = row as ContactItem;
    if (isCandidate(contact)) scan.leads.push(toLead(contact));
  }
  scan.leads.sort(compareLeads);
  return scan;
}

/**
 * Spec D10: an entity's WHOLE audit history. listByEntity is one newest-first
 * Query with no cursor, so this pages backward with `before` = the oldest ts
 * seen until a page comes back empty. A page that does not move back (a store
 * ignoring `before`) throws rather than loop forever.
 */
export async function readWholeHistory(
  audit: Pick<AuditRepo, 'listByEntity'>,
  entityKey: string,
  pageSize: number,
): Promise<AuditEvent[]> {
  const events: AuditEvent[] = [];
  let before: string | undefined;
  for (;;) {
    const page = await audit.listByEntity(entityKey, { limit: pageSize, ...(before !== undefined && { before }) });
    if (page.length === 0) return events;
    events.push(...page);
    const oldest = page.reduce((min, e) => (e.ts < min ? e.ts : min), page[0]!.ts);
    if (before !== undefined && oldest >= before) {
      throw new Error(`${SCRIPT_NAME}: audit history paging did not advance for ${entityKey}`);
    }
    before = oldest;
  }
}

/**
 * Why one candidate is left out, or null when it is a target: --skip first
 * (no history read), then its whole history (leftOutReasonFromAudit).
 */
export async function leftOutReasonFor(
  deps: Pick<BackfillDeps, 'audit' | 'auditPageSize'>,
  contactId: string,
  skip: ReadonlySet<string>,
): Promise<LeftOutReason | null> {
  if (skip.has(contactId)) return 'skipped';
  const events = await readWholeHistory(deps.audit, `contacts#${contactId}`, deps.auditPageSize ?? AUDIT_PAGE_SIZE);
  return leftOutReasonFromAudit(events);
}

// ---------------------------------------------------------------------------
// The run (dry run by default; --apply writes)
// ---------------------------------------------------------------------------

export interface BackfillOptions {
  /** Write. false = the dry run: nothing is written at all. */
  apply: boolean;
  /** --skip: contactIds to leave out. An id that names no candidate is reported, otherwise ignored. */
  skip: ReadonlySet<string>;
}

/**
 * One target's write (spec D10): ONE conditional update that sets the
 * authority only while the contact still has none, is still a tenant and is
 * still not deleted - a lost condition is `skipped` - then its
 * housing_authority_backfill event. The event follows the landed write, so a
 * failed append is a warning, never a failure (a re-run finds the lead
 * holding an authority and cannot write it). Never throws.
 */
async function writeOne(deps: BackfillDeps, contactId: string, report: BackfillReport): Promise<TargetOutcome> {
  try {
    await deps.contacts.update(
      contactId,
      { [FIELD]: BACKFILL_AUTHORITY },
      {
        expect: [
          { attr: FIELD, value: null },
          { attr: 'type', value: 'tenant' },
        ],
        notDeleted: true,
      },
    );
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) {
      report.skipped += 1;
      deps.logger.info({ contactId }, `${SCRIPT_NAME} - the contact changed after the run read it; skipped, nothing written`);
      return 'skipped';
    }
    report.failed += 1;
    deps.logger.error({ err, contactId }, `${SCRIPT_NAME} - the write FAILED; nothing written for this contact`);
    return 'failed';
  }
  report.written += 1;
  try {
    await deps.audit.append(`contacts#${contactId}`, BACKFILL_AUDIT_TYPE, { field: FIELD, from: '', to: BACKFILL_AUTHORITY });
  } catch (err) {
    report.warnings.push(
      `the ${BACKFILL_AUDIT_TYPE} audit event for contactId ${contactId} could not be written (its housing authority was set).`,
    );
    deps.logger.warn({ err, contactId }, `${SCRIPT_NAME} - audit event could NOT be written (the write landed); continuing`);
  }
  deps.logger.info({ contactId }, `${SCRIPT_NAME} - housing authority set`);
  return 'written';
}

/**
 * Spec D10: after an apply that wrote, the name must still be an exact
 * housing_authority name. The run never takes the rewrite lock, so a rename,
 * merge, delete or kind change during the run is caught here - a warning.
 */
async function warnIfNameLeftList(deps: BackfillDeps, report: BackfillReport): Promise<void> {
  let item: OrgListItem | null;
  try {
    item = await deps.orgList.peek();
  } catch (err) {
    report.warnings.push(
      `the organization list could not be read again after the apply, so the run could not confirm "${BACKFILL_AUTHORITY}" ` +
        'is still on it - check Settings > Housing authorities & agencies > "Not on the list".',
    );
    deps.logger.warn({ err }, `${SCRIPT_NAME} - could not read the organization list again after the apply`);
    return;
  }
  if (item !== null && isOnListFor(item.entries, BACKFILL_AUTHORITY, KINDS_FOR_FIELD.housingAuthority)) return;
  report.warnings.push(
    `"${BACKFILL_AUTHORITY}" is no longer the exact name of a housing authority on the organization list (renamed, ` +
      `merged away, deleted or made an agency during the run): the ${report.written} record(s) written show under Settings > ` +
      'Housing authorities & agencies > "Not on the list" - settle them there.',
  );
  deps.logger.warn({ written: report.written }, `${SCRIPT_NAME} - the backfilled name left the organization list during the run`);
}

/**
 * Spec D10: the backfill. Refuses (BackfillRefusedError) before any contact
 * is read; then reads the candidates, and for each - oldest first - reads its
 * whole history right before its write; then (apply) re-checks the list,
 * prints the report through deps.print and returns it. A failed history read
 * or write is counted `failed` (exit 1) and the run goes on; only the list
 * read and the contacts Scan abort it, both before any write.
 */
export async function runJoinAuthorityBackfill(deps: BackfillDeps, opts: BackfillOptions): Promise<BackfillReport> {
  const log = deps.logger;
  await checkBackfillList(deps, opts.apply);
  const scan = await scanCandidates(deps);
  log.info(
    { contactsScanned: scan.contactsScanned, pointerRows: scan.pointerRows, candidates: scan.leads.length, apply: opts.apply },
    `${SCRIPT_NAME} - candidates read`,
  );
  const candidateIds = new Set(scan.leads.map((l) => l.contactId));
  const report: BackfillReport = {
    targets: [],
    leftOut: [],
    unknownSkips: [...opts.skip].filter((id) => !candidateIds.has(id)).sort(),
    written: 0,
    skipped: 0,
    failed: 0,
    warnings: [],
  };

  for (const lead of scan.leads) {
    let reason: LeftOutReason | null;
    try {
      reason = await leftOutReasonFor(deps, lead.contactId, opts.skip);
    } catch (err) {
      report.failed += 1;
      report.targets.push({ ...lead, outcome: 'failed' });
      log.error({ err, contactId: lead.contactId }, `${SCRIPT_NAME} - could not read the audit history; nothing written for this contact`);
      continue;
    }
    if (reason !== null) {
      report.leftOut.push({ ...lead, reason });
      log.info({ contactId: lead.contactId, reason }, `${SCRIPT_NAME} - left out`);
      continue;
    }
    if (!opts.apply) {
      report.targets.push({ ...lead, outcome: 'would_write' });
      log.info({ contactId: lead.contactId }, `${SCRIPT_NAME} - DRY RUN: would set the housing authority`);
      continue;
    }
    report.targets.push({ ...lead, outcome: await writeOne(deps, lead.contactId, report) });
  }

  if (opts.apply && report.written > 0) await warnIfNameLeftList(deps, report);

  const counts = {
    candidates: scan.leads.length,
    targets: report.targets.length,
    leftOut: report.leftOut.length,
    unknownSkips: report.unknownSkips.length,
    written: report.written,
    skipped: report.skipped,
    failed: report.failed,
    warnings: report.warnings.length,
    apply: opts.apply,
  };
  const suffix = opts.apply ? '' : ' (DRY RUN - nothing written)';
  if (report.failed > 0) {
    log.warn(
      counts,
      `${SCRIPT_NAME} - COMPLETED WITH FAILURES${suffix}: ${report.failed} lead(s) FAILED and were left as they were (see the ERROR lines naming them). Re-run (idempotent).`,
    );
  } else if (report.warnings.length > 0) {
    log.warn(counts, `${SCRIPT_NAME} - done${suffix}, with ${report.warnings.length} warning(s): read the WARNING lines of the report`);
  } else {
    log.info(counts, `${SCRIPT_NAME} - done${suffix}`);
  }
  for (const line of formatBackfillReport(report, opts.apply)) deps.print(line);
  return report;
}

// ---------------------------------------------------------------------------
// The CLI
// ---------------------------------------------------------------------------

/** The argument names the CLI accepts beside --env and --lane (parseStageArgs refuses any other, and any repeat). */
export const BACKFILL_ARGS = { values: ['--skip'], flags: ['--apply'] };

/**
 * --skip's value: contactIds, comma-separated, each trimmed; absent = none.
 * An empty id (an empty value, a stray comma) is a usage error: undefined.
 */
export function parseSkipList(raw: string | undefined): ReadonlySet<string> | undefined {
  if (raw === undefined) return new Set();
  const ids = raw.split(',').map((id) => id.trim());
  return ids.some((id) => id === '') ? undefined : new Set(ids);
}

/** What a usage error prints (exit 2). */
export const USAGE =
  `Usage: npx tsx app/scripts/${SCRIPT_NAME}.ts --env local|dev|prod [--lane <L>] [--apply] [--skip "<contactId>[,<contactId>...]"]\n` +
  '  DRY RUN by default; --apply writes. --skip leaves the named leads out (ONE comma-separated value - quote it).\n' +
  '  Unknown or repeated arguments and an empty --skip id are refused. --lane selects a hermetic e2e lane (local only).';

/** The CLI's outside world - each member injectable, so the tests execute every exit code. */
export interface CliDeps {
  /** --env/--lane -> the stage client (default: resolveStageClient; for dev/prod the account guard runs first). */
  resolveStage: (target: StageTarget, opts: StageClientOpts) => Promise<StageClient>;
  /** The run on that client (default: runJoinAuthorityBackfill on buildBackfillDeps(stage)). */
  run: (stage: StageClient, opts: BackfillOptions) => Promise<BackfillReport>;
  /** The usage text and a refusal's message (default: console.error). */
  printError: (text: string) => void;
  logger: Logger;
}

/**
 * The CLI (spec D10). Resolves to the exit code: 2 a usage error (nothing
 * resolved, nothing read); 1 the target could not be resolved (nothing read),
 * the run was refused (no contact read), it stopped before any write (the list
 * read or the contacts Scan failed), or it completed with a failed lead; 0 it
 * completed clean, warnings included. Once resolved, the stage client is
 * destroyed whatever happens.
 */
export async function main(argv: readonly string[], cli: Partial<CliDeps> = {}): Promise<0 | 1 | 2> {
  const printError = cli.printError ?? ((text: string) => console.error(text));
  const log = cli.logger ?? defaultLogger;
  const resolveStage: CliDeps['resolveStage'] =
    cli.resolveStage ?? ((target, opts) => resolveStageClient(target, {}, opts));
  const run: CliDeps['run'] = cli.run ?? ((stage, opts) => runJoinAuthorityBackfill(buildBackfillDeps(stage), opts));

  const parsed = parseStageArgs([...argv], BACKFILL_ARGS);
  const skip = 'usage' in parsed ? undefined : parseSkipList(parsed.values.get('--skip'));
  if ('usage' in parsed || skip === undefined) {
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
  // STEP 2 - the run. It prints its own report.
  try {
    log.info(
      { target: parsed.target, endpoint: stage.describe, prefix: stage.prefix, apply, skip: skip.size },
      `${SCRIPT_NAME} - starting`,
    );
    return backfillExitCode(await run(stage, { apply, skip }));
  } catch (err) {
    if (err instanceof BackfillRefusedError) {
      printError(err.message);
      return 1;
    }
    // The list read or the contacts Scan failed: the run stopped before any write.
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
