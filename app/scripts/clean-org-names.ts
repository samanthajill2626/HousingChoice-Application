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
import { isOnListFor, KINDS_FOR_FIELD, resolveOrgText, type OrgEntry } from '../src/lib/orgNames.js';

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
