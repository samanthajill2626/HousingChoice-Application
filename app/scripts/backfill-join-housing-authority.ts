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
import type { AuditEvent } from '../src/repos/auditRepo.js';
import { isDeleted, type ContactItem } from '../src/repos/contactsRepo.js';

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
