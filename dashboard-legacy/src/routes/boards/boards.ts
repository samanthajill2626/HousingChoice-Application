// Pure, unit-testable helpers for the M1.10 "Boards" (cases) harness. Kept apart
// from the views so the label/formatting rules can be tested without rendering.
// A "case" is one tenant↔unit deal moving through the stage ladder; the boards
// are staff-facing (so we say "listing", never "property").
import type { BadgeTone } from '../../ui';
import type { CaseDeadlineType, CaseItem, CaseStage } from '../../api';

/** Human label for a case stage (the kanban column header + the stage badge). */
export const CASE_STAGE_LABEL: Record<CaseStage, string> = {
  interested: 'Interested',
  porting: 'Porting',
  touring: 'Touring',
  applied: 'Applied',
  rta_submitted: 'RTA submitted',
  inspection: 'Inspection',
  rent_determined: 'Rent determined',
  lease: 'Lease',
  moved_in: 'Moved in',
  lost: 'Lost',
};

/** Badge tone for a case stage — the two terminals stand out (success / muted),
 *  everything mid-ladder is informational. */
export function caseStageTone(stage: CaseStage): BadgeTone {
  switch (stage) {
    case 'moved_in':
      return 'success';
    case 'lost':
      return 'neutral';
    default:
      return 'info';
  }
}

/** Human label for a deadline type (the deadline <select> + the detail line). */
export const CASE_DEADLINE_TYPE_LABEL: Record<CaseDeadlineType, string> = {
  tour_reminder: 'Tour reminder',
  rta_window: 'RTA 48-hour window',
  voucher_expiration: 'Voucher expiration',
  stuck_case: 'Stuck case',
  follow_up: 'Follow up',
};

/** The deadline types offered in the detail <select>, in UI order. */
export const CASE_DEADLINE_TYPES: readonly CaseDeadlineType[] = [
  'tour_reminder',
  'rta_window',
  'voucher_expiration',
  'stuck_case',
  'follow_up',
];

/** The card title: the operator's placement_tag when set, else a short caseId
 *  stub (never fabricated). */
export function caseTitle(c: Pick<CaseItem, 'placement_tag' | 'caseId'>): string {
  if (typeof c.placement_tag === 'string' && c.placement_tag.trim().length > 0) {
    return c.placement_tag.trim();
  }
  return `Case ${c.caseId.slice(0, 8)}`;
}

/** Format an ISO 8601 instant for display (local), or undefined when absent. */
export function formatDateTime(at: string | undefined | null): string | undefined {
  if (typeof at !== 'string' || at.length === 0) return undefined;
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return at;
  return d.toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** Format a YYYY-MM-DD date for display, or undefined when absent. We parse at
 *  UTC noon so the calendar day never shifts under a negative timezone offset. */
export function formatDate(ymd: string | undefined | null): string | undefined {
  if (typeof ymd !== 'string' || ymd.length === 0) return undefined;
  const d = new Date(`${ymd}T12:00:00`);
  if (Number.isNaN(d.getTime())) return ymd;
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

/**
 * Group cases into their stage columns, preserving every stage (an empty column
 * still renders so the board is stable). Within a column the cases are sorted
 * newest-ish first by updated_at (falling back to created_at, then caseId).
 */
export function groupByStage(
  cases: readonly CaseItem[],
  stages: readonly CaseStage[],
): { stage: CaseStage; cases: CaseItem[] }[] {
  const buckets = new Map<CaseStage, CaseItem[]>();
  for (const stage of stages) buckets.set(stage, []);
  for (const c of cases) {
    // A stray/unknown stage from the wire shouldn't crash the board — drop it
    // into its column only when it's a known stage.
    const bucket = buckets.get(c.stage);
    if (bucket) bucket.push(c);
  }
  const recency = (c: CaseItem): string => c.updated_at ?? c.created_at ?? '';
  for (const bucket of buckets.values()) {
    bucket.sort((a, b) => {
      const cmp = recency(b).localeCompare(recency(a));
      return cmp !== 0 ? cmp : b.caseId.localeCompare(a.caseId);
    });
  }
  return stages.map((stage) => ({ stage, cases: buckets.get(stage) ?? [] }));
}
