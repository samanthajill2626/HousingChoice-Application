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
