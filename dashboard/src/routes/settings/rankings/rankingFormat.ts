// rankingFormat - every label and status line the Rankings page shows (WP1
// B2a spec D18), in one place so the components and the e2e assert one
// copy. Display only: bands, caps and out-of-date reasons arrive derived from
// the server, never computed here (plan PR7). Staff copy says "property".
import type {
  RankingAnchorNote,
  RankingAnchorRef,
  RankingBand,
  RankingDirection,
  RankingJobStatus,
  RankingJobView,
  RankingOutOfDateReason,
  RankingReason,
} from '../../../api/index.js';

export const NOT_RANKED_YET = 'not ranked yet';
export const NOT_SCORED = 'not scored - retry';

const BAND_LABELS: Readonly<Record<RankingBand, string>> = {
  strong: 'Strong',
  good: 'Good',
  possible: 'Possible',
  weak: 'Weak',
};

export function bandLabel(band: RankingBand): string {
  return BAND_LABELS[band];
}

/** The read's cap has one reason (spec D9). */
export function cappedText(capped: boolean): string {
  return capped ? 'Capped: requirement not met' : 'No';
}

const OUT_OF_DATE_LABELS: Readonly<Record<RankingOutOfDateReason, string>> = {
  card: 'a card changed',
  pairHistory: 'their history changed',
  age: 'too old',
  version: 'the rubric or model changed',
  failedBatch: 'the last ranking failed for it',
  unverified: 'could not check whether this match is current',
};

export function outOfDateText(reasons: readonly RankingOutOfDateReason[]): string {
  if (reasons.length === 0) return '-';
  return `Out of date: ${reasons.map((reason) => OUT_OF_DATE_LABELS[reason]).join(', ')}`;
}

/** Reasons with their sources: "Rent fits (rent); Said no stairs (staff notes)". */
export function reasonsText(reasons: readonly RankingReason[]): string {
  if (reasons.length === 0) return '-';
  return reasons.map((reason) => `${reason.text} (${reason.source.replaceAll('_', ' ')})`).join('; ');
}

export const ANCHOR_NOTE_TEXT: Readonly<Record<RankingAnchorNote, string>> = {
  not_searching: 'This tenant is not searching.',
  not_sendable: 'This tenant cannot be texted.',
  not_available: 'This property is not available.',
};

export function directionLabel(direction: RankingDirection): string {
  return direction === 'tenants_for_property' ? 'Tenants for property' : 'Properties for tenant';
}

export function formatCost(usd: number): string {
  return `$${usd.toFixed(4)}`;
}

export function isJobLive(status: RankingJobStatus): boolean {
  return status === 'queued' || status === 'running';
}

/** Distinct CANDIDATES the job left without a new match (plan PR42): every
 *  candidate listed in a failedBatches entry (a failed call, run write or
 *  match write lists exactly the candidates that got no match) plus every
 *  notScored entry. */
export function notScoredCount(job: RankingJobView): number {
  const ids = new Set<string>();
  for (const batch of job.failedBatches) for (const id of batch.candidateIds) ids.add(id);
  for (const entry of job.notScored) ids.add(entry.candidateId);
  return ids.size;
}

function candidatesText(n: number): string {
  return `${n} candidate${n === 1 ? '' : 's'} not scored`;
}

/** Distinct indexes of the batches that failed and did NOT score. A partial
 *  match write (failure 'repo', which S5 records only after a successful
 *  call) has its index in BOTH batchesDone and failedBatches; the filter
 *  keeps such a batch from being counted twice as finished. */
function failedBatchIndexes(job: RankingJobView): Set<number> {
  const scored = new Set(job.batchesDone);
  return new Set(job.failedBatches.map((batch) => batch.index).filter((index) => !scored.has(index)));
}

/** FINISHED batches, scored or failed, by distinct index - what the page
 *  re-reads the ranking on (spec D12; plan review BB5) and the same count
 *  S5's event carries as `batchesDone`. */
export function finishedBatchCount(job: RankingJobView): number {
  return new Set(job.batchesDone).size + failedBatchIndexes(job).size;
}

/** The job's status (spec D7, D12; plan PR13, PR42). Progress is counted in
 *  FINISHED batches; what was lost is counted in CANDIDATES not scored -
 *  never "a batch failed", since a batch whose match write half-landed is a
 *  failedBatches entry too. The job's own message (the PR38 / PR43 "could
 *  not read" text, or S5's count) follows; with none, a loss ends "Press
 *  Rank again.". */
export function jobStatusText(job: RankingJobView): string {
  const count = job.batchCount;
  const lost = notScoredCount(job);
  switch (job.status) {
    case 'queued':
      return 'Waiting for a free slot';
    case 'running': {
      if (count === 0) return 'Ranking...';
      const base = `Ranking: ${finishedBatchCount(job)} of ${count} batches finished`;
      return lost > 0 ? `${base}; ${candidatesText(lost)}` : base;
    }
    case 'done': {
      // PR38 / PR43: an anchor whose own reads failed after the pool was
      // computed finishes with no batch and every candidate not scored.
      const base =
        count === 0
          ? lost > 0
            ? `Done: ${candidatesText(lost)}`
            : 'Done: no candidates to rank'
          : `Done: ${count} batch${count === 1 ? '' : 'es'}${lost > 0 ? `; ${candidatesText(lost)}` : ''}`;
      if (job.message !== undefined && job.message !== '') return `${base}. ${job.message}`;
      return lost > 0 ? `${base}. Press Rank again.` : base;
    }
    case 'failed':
      return job.message ?? 'The ranking failed. Press Rank again.';
    case 'expired':
      return job.message ?? 'The ranking was not picked up. Press Rank again.';
  }
}

/** The run detail's "since re-scored" mark (spec D11). */
export function currentMatchText(currentRunId: string | null, runId: string): string {
  if (currentRunId === null) return 'No current match';
  return currentRunId === runId ? 'This run' : 'Since re-scored';
}

/** An anchor in the URL: `<kind>:<id>` (the id may itself hold a colon). */
export function anchorParam(anchor: RankingAnchorRef): string {
  return `${anchor.kind}:${anchor.id}`;
}

export function parseAnchorParam(value: string | null): RankingAnchorRef | undefined {
  if (value === null) return undefined;
  const at = value.indexOf(':');
  if (at <= 0) return undefined;
  const kind = value.slice(0, at);
  const id = value.slice(at + 1);
  if (id === '') return undefined;
  if (kind === 'unit' || kind === 'tenant') return { kind, id };
  return undefined;
}
